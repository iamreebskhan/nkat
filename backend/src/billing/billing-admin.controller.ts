/**
 * BillingAdminController — admin-tier endpoints used by the in-app
 * dunning UI and the self-serve seat-add flow.
 *
 *   GET  /v1/admin/billing/dunning-state
 *     Returns { banner: 'past_due' | 'unpaid' | 'trial_ending' | null,
 *               days_until_period_end?, hosted_invoice_url? }
 *
 *   POST /v1/admin/billing/seats
 *     Body: { quantity: number }
 *     Bumps the subscription's seat count via Stripe (with prorations) and
 *     applies the Stripe-returned state to our local subscription cache.
 *
 * Both endpoints are auth-guarded. Seat-add is gated on the caller's
 * tier — Solo tier can't seat-add (can only Team-and-above), so the guard
 * rejects with a recognized 403 code the UI can surface.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Logger,
  Optional,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuthGuard } from '../auth/auth.guard';
import { Idempotent } from '../common/idempotency/idempotency.interceptor';
import { assertUuid } from '../common/uuid';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import { runReadOnlyWithTenant, runWithTenant } from '../database/rls-transaction';
import { BillingService } from './billing.service';
import {
  ALL_SPECIALTY_PACKS,
  type SpecialtyPack,
  type StripeClient,
  type SubscriptionTier,
} from './billing-types';
import { isSelfServeTier, resolvePriceId } from './price-catalog';

export const STRIPE_CLIENT_TOKEN = Symbol('STRIPE_CLIENT');

class SeatChangeDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;
}

class PortalSessionDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  return_url!: string;
}

class CheckoutSessionDto {
  @IsString()
  @IsIn(['solo', 'team', 'org'])
  tier!: 'solo' | 'team' | 'org';

  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;

  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  success_url!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  cancel_url!: string;

  @IsOptional()
  @IsEmail()
  customer_email?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  states?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_SPECIALTY_PACKS as readonly string[], { each: true })
  specialty_packs?: SpecialtyPack[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  trial_days?: number;
}

const SEATS_BY_TIER: Record<SubscriptionTier, { min: number; max: number }> = {
  solo: { min: 1, max: 1 },
  team: { min: 2, max: 10 },
  org: { min: 11, max: 100 },
  enterprise: { min: 1, max: 10_000 }, // contracted ceilings handled out-of-band
};

@ApiTags('admin')
@Controller('v1/admin/billing')
@UseGuards(AuthGuard)
export class BillingAdminController {
  private readonly log = new Logger(BillingAdminController.name);
  constructor(
    private readonly billing: BillingService,
    @Inject(DB_TOKEN) private readonly db: Db,
    @Optional() @Inject(STRIPE_CLIENT_TOKEN) private readonly stripe?: StripeClient,
  ) {}

  @Get('dunning-state')
  @ApiOperation({ summary: 'Banner state for the in-app dunning UI' })
  async dunningState(@Req() req: Request) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const ent = await this.billing.getEntitlement(orgId);
    if (!ent) return { banner: null };

    const now = Date.now();
    const periodEndRow = await runReadOnlyWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('subscription')
        .select(['current_period_end', 'trial_end', 'stripe_subscription_id'])
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    );

    const daysUntil = (d: Date | null) =>
      d ? Math.max(0, Math.ceil((d.getTime() - now) / 86_400_000)) : null;

    if (ent.status === 'past_due') {
      return {
        banner: 'past_due',
        message:
          'Your last invoice failed to charge. Update your payment method to avoid service interruption.',
        days_until_period_end: daysUntil(periodEndRow?.current_period_end ?? null),
      };
    }
    if (ent.status === 'unpaid') {
      return {
        banner: 'unpaid',
        message:
          'Your subscription has unpaid invoices and is blocked from changes. Pay now to restore.',
      };
    }
    if (ent.status === 'trialing' && periodEndRow?.trial_end) {
      const days = daysUntil(periodEndRow.trial_end);
      if (days !== null && days <= 7) {
        return {
          banner: 'trial_ending',
          message: `Trial ends in ${days} days. Add a payment method to keep access.`,
          days_until_trial_end: days,
        };
      }
    }
    return { banner: null };
  }

  @Post('checkout-session')
  @Idempotent()
  @ApiOperation({ summary: 'Create a Stripe Checkout session for self-serve tier purchase' })
  async checkoutSession(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CheckoutSessionDto,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!this.stripe?.createCheckoutSession) {
      throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED' });
    }
    if (!isSelfServeTier(body.tier as SubscriptionTier)) {
      throw new BadRequestException({ code: 'TIER_NOT_SELF_SERVE', tier: body.tier });
    }
    const priceId = resolvePriceId(body.tier as SubscriptionTier);
    if (!priceId) {
      throw new ServiceUnavailableException({ code: 'PRICE_NOT_CONFIGURED', tier: body.tier });
    }
    const session = await this.stripe.createCheckoutSession({
      priceId,
      quantity: body.quantity,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
      customerEmail: body.customer_email,
      orgId,
      tier: body.tier,
      states: body.states,
      specialty_packs: body.specialty_packs,
      trialDays: body.trial_days,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    this.log.log(
      `org=${orgId} checkout session ${session.id} (tier=${body.tier} qty=${body.quantity})`,
    );
    return { url: session.url };
  }

  @Post('portal-session')
  @ApiOperation({ summary: 'Create a Stripe Customer Portal session for the calling tenant' })
  async portalSession(@Req() req: Request, @Body() body: PortalSessionDto) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    if (!this.stripe?.createPortalSession) {
      throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED' });
    }
    const row = await runReadOnlyWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('subscription')
        .select(['stripe_customer_id'])
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    );
    const customerId = row?.stripe_customer_id;
    if (!customerId) {
      throw new ServiceUnavailableException({ code: 'STRIPE_CUSTOMER_NOT_LINKED' });
    }
    const session = await this.stripe.createPortalSession({
      customerId,
      returnUrl: body.return_url,
    });
    this.log.log(`org=${orgId} portal session ${session.id} created`);
    return { url: session.url, expires_at: session.expires_at };
  }

  @Post('seats')
  @Idempotent()
  @ApiOperation({ summary: 'Self-serve seat increase (writes through Stripe with prorations)' })
  async addSeats(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SeatChangeDto,
  ) {
    const orgId = assertUuid(req.auth?.orgId, 'orgId');
    const ent = await this.billing.getEntitlement(orgId);
    if (!ent) {
      throw new ForbiddenException({ code: 'NO_SUBSCRIPTION' });
    }
    if (ent.in_grace_period) {
      throw new ForbiddenException({ code: 'PAYMENT_REQUIRED' });
    }
    if (ent.status !== 'active' && ent.status !== 'trialing') {
      throw new ForbiddenException({ code: 'INACTIVE_SUBSCRIPTION' });
    }
    const bounds = SEATS_BY_TIER[ent.tier];
    if (body.quantity < bounds.min || body.quantity > bounds.max) {
      throw new BadRequestException({
        code: 'SEATS_OUT_OF_TIER_RANGE',
        tier: ent.tier,
        min: bounds.min,
        max: bounds.max,
      });
    }
    if (!this.stripe) {
      throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED' });
    }

    // Find the Stripe subscription id + the first item id from our cache.
    const row = await runReadOnlyWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('subscription')
        .select(['stripe_subscription_id', 'metadata'])
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    );
    const subId = row?.stripe_subscription_id;
    const itemId = (row?.metadata as Record<string, unknown> | undefined)?.stripe_item_id;
    if (!subId || typeof itemId !== 'string') {
      throw new ServiceUnavailableException({ code: 'STRIPE_SUBSCRIPTION_NOT_LINKED' });
    }

    // Update via Stripe (prorations on by default). The webhook will fire
    // a customer.subscription.updated which BillingService.ingestEvent
    // will absorb. We also write through our local cache so the next read
    // doesn't have to wait for the webhook hop.
    if (!this.stripe.updateSubscriptionSeats) {
      throw new ServiceUnavailableException({ code: 'STRIPE_SEATS_NOT_SUPPORTED' });
    }
    await this.stripe.updateSubscriptionSeats({
      subscriptionId: subId,
      subscriptionItemId: itemId,
      quantity: body.quantity,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    await runWithTenant(this.db, orgId, (tx) =>
      tx
        .updateTable('subscription')
        .set({ seats: body.quantity, updated_at: sql`now()` })
        .where('org_id', '=', orgId)
        .execute(),
    );

    this.log.log(`org=${orgId} seats: ${ent.seats} → ${body.quantity}`);
    return { ok: true, seats: body.quantity };
  }
}
