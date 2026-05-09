/**
 * BillingController — three responsibilities:
 *
 *   1. POST /v1/billing/stripe-webhook  — Stripe → us. The endpoint reads
 *      the raw body (NOT body-parsed) so the HMAC signature stays
 *      reproducible, verifies it locally with our own HMAC verifier
 *      (keeping Stripe SDK out of the hot path), and dispatches to
 *      BillingService.ingestEvent.
 *
 *   2. GET  /v1/billing/entitlement     — caller's effective entitlement.
 *      Auth-guarded; reads the cached subscription row via RLS.
 *
 * Note: webhook bodies are untrusted. We derive `org_id` from the embedded
 * Stripe customer's metadata, NOT from any request header. The webhook
 * controller never trusts an `x-org-id` header from Stripe.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Optional,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { assertUuid } from '../common/uuid';
import { BillingService } from './billing.service';
import {
  InvalidWebhookSignatureError,
  type StripeEventLike,
  type StripeSubscriptionLike,
} from './billing-types';
import { verifyStripeSignature } from './stripe-hmac';
import { MetricsService } from '../observability/metrics.service';

export const STRIPE_SIGNING_SECRET_TOKEN = Symbol('STRIPE_SIGNING_SECRET');

@ApiTags('billing')
@Controller('v1/billing')
export class BillingController {
  private readonly log = new Logger(BillingController.name);
  constructor(
    private readonly billing: BillingService,
    @Inject(STRIPE_SIGNING_SECRET_TOKEN) private readonly signingSecret: string | string[],
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Post('stripe-webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stripe webhook receiver (HMAC-verified locally)' })
  async stripeWebhook(
    @Headers('stripe-signature') signatureHeader: string | undefined,
    @Req() req: Request,
  ): Promise<{ received: true; duplicate: boolean }> {
    // The raw body is attached by a Nest middleware that captures
    // req.rawBody for this route ONLY. (Wired in main.ts.)
    const rawBody = (req as Request & { rawBody?: string }).rawBody;
    if (!rawBody) {
      throw new BadRequestException('raw body not captured');
    }
    const secrets = Array.isArray(this.signingSecret)
      ? this.signingSecret.filter((s) => typeof s === 'string' && s.length > 0)
      : this.signingSecret
        ? [this.signingSecret]
        : [];
    if (secrets.length === 0) {
      throw new BadRequestException('webhook signing secret not configured');
    }

    let secretIndex = 0;
    try {
      const r = verifyStripeSignature({
        header: signatureHeader ?? '',
        rawBody,
        signingSecret: secrets,
      });
      secretIndex = r.secretIndex;
      this.metrics?.increment('billing_rules.stripe.webhook_secret_index', 1, {
        secret_index: secretIndex,
      });
      if (secrets.length > 1 && secretIndex > 0) {
        // A non-primary secret matched. Surfaces the rotation
        // status to ops dashboards: when this number drops to zero
        // for ~24h the previous secret can be retired.
        this.log.warn(`stripe webhook verified by rotation secret #${secretIndex} (primary is #0)`);
      }
    } catch (e) {
      if (e instanceof InvalidWebhookSignatureError) {
        this.log.warn(`stripe webhook signature rejected: ${e.message}`);
        throw new BadRequestException('invalid signature');
      }
      throw e;
    }

    let event: StripeEventLike;
    try {
      event = JSON.parse(rawBody) as StripeEventLike;
    } catch {
      throw new BadRequestException('invalid JSON body');
    }
    if (typeof event.id !== 'string' || typeof event.type !== 'string') {
      throw new BadRequestException('event missing id/type');
    }

    // Derive orgId from the event's subscription metadata. Webhook bodies
    // are untrusted data per the system prompt — we only act on
    // metadata.org_id that Stripe shipped, never on a request header.
    const sub = extractSubscription(event);
    const orgIdRaw = sub?.metadata?.org_id;
    if (!orgIdRaw) {
      this.log.warn(`stripe event ${event.id} (${event.type}) had no metadata.org_id; ignoring`);
      return { received: true, duplicate: false };
    }
    const orgId = assertUuid(orgIdRaw, 'org_id');

    const { duplicate } = await this.billing.ingestEvent({ orgId, event, subscription: sub });
    return { received: true, duplicate };
  }

  @Get('entitlement')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Return the caller tenant's current entitlement (tier/seats/states/packs)",
  })
  async entitlement(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const ent = await this.billing.getEntitlement(orgId);
    if (!ent) return { tier: null, active: false };
    return ent;
  }

  @Get('portal-redirect')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary:
      'Convenience: 302-redirect to a freshly minted Stripe customer-portal session. ' +
      'Frontend uses this as a plain <a href> from the billing page.',
  })
  async portalRedirect(@Req() req: Request, @Res() res: Response) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const url = await this.billing.createPortalSessionUrl(orgId);
    if (!url) {
      throw new BadRequestException({ code: 'STRIPE_NOT_CONFIGURED_OR_NO_CUSTOMER' });
    }
    res.redirect(302, url);
  }
}

/** Pull a Stripe subscription out of an event payload, when present. */
function extractSubscription(event: StripeEventLike): StripeSubscriptionLike | null {
  if (event.type.startsWith('customer.subscription.')) {
    return event.data.object as StripeSubscriptionLike;
  }
  // For invoice.* events, Stripe nests the subscription id; we don't
  // re-fetch it here — that's the production responsibility of a
  // background reconciler that calls StripeClient.retrieveSubscription.
  return null;
}
