/**
 * BillingService — applies Stripe-derived state to the local subscription
 * cache and returns the customer's current entitlements (tier / seats /
 * states / specialty packs) for the tier-guard interceptor.
 *
 * Pure-ish: all I/O goes through the Kysely `Tx` passed in. Stripe is
 * never imported here; the webhook controller passes already-verified
 * events. Unit tests instantiate the service directly with an in-memory
 * tx mock or a real Postgres tx.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { runWithTenant, type Tx } from '../database/rls-transaction';
import type { Database } from '../database/schema.types';
import { EmailService } from '../email/email.service';
import type {
  StripeClient,
  StripeEventLike,
  StripeSubscriptionLike,
  SubscriptionStatus,
  SubscriptionTier,
} from './billing-types';

export interface Entitlement {
  tier: SubscriptionTier;
  seats: number;
  states: string[];
  specialty_packs: string[];
  status: SubscriptionStatus;
  active: boolean;          // true when status ∈ {trialing, active}
  in_grace_period: boolean; // true when past_due / unpaid (read-only access allowed)
  current_period_end: string | null;  // ISO timestamp for UI display
  trial_end: string | null;
}

const ACTIVE: ReadonlySet<SubscriptionStatus> = new Set(['trialing', 'active']);
const GRACE: ReadonlySet<SubscriptionStatus> = new Set(['past_due', 'unpaid']);

@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);
  constructor(
    private readonly db: Kysely<Database>,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly appUrl?: string,
    @Optional() private readonly stripe?: StripeClient,
  ) {}

  /**
   * Mint a Stripe Customer Portal URL for an org. Returns null when
   * Stripe isn't configured or the org has no linked customer (the
   * controller turns that into a 4xx).
   */
  async createPortalSessionUrl(orgId: string): Promise<string | null> {
    if (!this.stripe?.createPortalSession) return null;
    const row = await runWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('subscription')
        .select(['stripe_customer_id'])
        .where('org_id', '=', orgId)
        .executeTakeFirst(),
    );
    const customerId = row?.stripe_customer_id;
    if (!customerId) return null;
    const returnUrl = this.appUrl
      ? `${this.appUrl}/settings/billing`
      : 'https://billing-rules.example.com/settings/billing';
    const session = await this.stripe.createPortalSession({ customerId, returnUrl });
    this.log.log(`org=${orgId} portal redirect → ${session.url}`);
    return session.url;
  }

  // -------------------------------------------------------------------------
  // Read paths
  // -------------------------------------------------------------------------

  /** Returns the entitlement record or null if no subscription exists. */
  async getEntitlement(orgId: string): Promise<Entitlement | null> {
    return runWithTenant(this.db, orgId, (tx) => this.getEntitlementInTx(tx, orgId));
  }

  async getEntitlementInTx(tx: Tx, orgId: string): Promise<Entitlement | null> {
    const row = await tx
      .selectFrom('subscription')
      .selectAll()
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      tier: row.tier,
      seats: row.seats,
      states: row.states,
      specialty_packs: row.specialty_packs,
      status: row.status,
      active: ACTIVE.has(row.status),
      in_grace_period: GRACE.has(row.status),
      current_period_end: row.current_period_end ? row.current_period_end.toISOString() : null,
      trial_end: row.trial_end ? row.trial_end.toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------
  // Webhook event ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest a verified Stripe event. Idempotent on `stripe_event_id` —
   * replaying the same event is a no-op (returns the already-stored row).
   * The `orgId` is derived by the controller from the Stripe customer's
   * metadata.org_id, NOT from the request — webhook bodies are untrusted
   * data per the system prompt.
   */
  async ingestEvent(args: {
    orgId: string;
    event: StripeEventLike;
    subscription: StripeSubscriptionLike | null;
  }): Promise<{ duplicate: boolean }> {
    return runWithTenant(this.db, args.orgId, async (tx) => {
      // Idempotency check.
      const existing = await tx
        .selectFrom('billing_event')
        .select('id')
        .where('stripe_event_id', '=', args.event.id)
        .executeTakeFirst();
      if (existing) {
        this.log.log(`stripe event ${args.event.id} already processed; skipping`);
        return { duplicate: true };
      }

      // Apply state to the subscription row when the event is one we
      // actually act on. Other event types still get logged for forensics
      // but don't mutate state.
      const computed = await this.applyEvent(tx, args.orgId, args.event, args.subscription);

      await tx
        .insertInto('billing_event')
        .values({
          org_id: args.orgId,
          stripe_event_id: args.event.id,
          event_type: args.event.type,
          computed_state: computed,
          raw_payload: (args.event as unknown) as Record<string, unknown>,
          occurred_at: new Date(args.event.created * 1000),
        })
        .execute();

      // Audit-log the state change for SOC 2 evidence. The audit_log row
      // contains the *computed_state* (post-state summary) — not raw PHI
      // and not the full Stripe payload. Replays / no-op events skip
      // audit logging to keep the trail signal-rich.
      const isStateChanging =
        args.event.type === 'customer.subscription.created' ||
        args.event.type === 'customer.subscription.updated' ||
        args.event.type === 'customer.subscription.deleted';
      if (isStateChanging) {
        await tx
          .insertInto('audit_log')
          .values({
            org_id: args.orgId,
            user_id: null,
            action: `billing.${args.event.type}`,
            target_type: 'subscription',
            target_id: args.subscription?.id ?? null,
            payload: { stripe_event_id: args.event.id, computed: computed },
            ip_address: null,
            user_agent: 'stripe-webhook',
          })
          .execute();
      }

      return { duplicate: false };
    }).then(async (r) => {
      // Fire welcome email on `customer.subscription.created` only.
      // Best-effort + idempotent on stripe_event_id so duplicate
      // delivery never re-mails the customer.
      if (
        !r.duplicate &&
        args.event.type === 'customer.subscription.created' &&
        this.email
      ) {
        await this.maybeSendWelcomeEmail(args.orgId, args.event.id).catch((e) =>
          this.log.warn(`welcome email failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return r;
    });
  }

  private async maybeSendWelcomeEmail(orgId: string, stripeEventId: string): Promise<void> {
    if (!this.email) return;
    const org = await runWithTenant(this.db, orgId, (tx) =>
      tx
        .selectFrom('org')
        .select(['name', 'primary_contact_email'])
        .where('id', '=', orgId)
        .executeTakeFirst(),
    );
    if (!org || !org.primary_contact_email) {
      this.log.warn(`welcome email skipped — org=${orgId} has no primary_contact_email`);
      return;
    }
    const appUrl = this.appUrl ?? 'https://app.example.com';
    await this.email.send({
      orgId,
      to: org.primary_contact_email,
      template: 'welcome',
      args: { org_name: org.name, app_url: appUrl },
      // Idempotency key gates ALL retries against the same stripe event,
      // including reconciler refetches that produce a synthetic event id.
      idempotencyKey: `welcome-${stripeEventId}`,
    });
  }

  /**
   * Apply a Stripe event to the subscription row. Returns the
   * computed state we wrote (or `{}` for events we ignored).
   */
  private async applyEvent(
    tx: Tx,
    orgId: string,
    event: StripeEventLike,
    sub: StripeSubscriptionLike | null,
  ): Promise<Record<string, unknown>> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        if (!sub) return {};
        const tier = parseTier(sub.metadata.tier);
        const seats = parseInt(sub.metadata.seats ?? '0', 10);
        const states = parseList(sub.metadata.states);
        const specialty_packs = parseList(sub.metadata.specialty_packs);
        await tx
          .insertInto('subscription')
          .values({
            org_id: orgId,
            tier,
            seats: seats > 0 ? seats : 1,
            states,
            specialty_packs,
            stripe_customer_id: sub.customer,
            stripe_subscription_id: sub.id,
            status: sub.status,
            current_period_start: new Date(sub.current_period_start * 1000),
            current_period_end: new Date(sub.current_period_end * 1000),
            trial_end: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
            cancel_at_period_end: sub.cancel_at_period_end,
            metadata: { source: 'stripe_webhook' },
          })
          .onConflict((oc) =>
            oc.column('org_id').doUpdateSet({
              tier,
              seats: seats > 0 ? seats : 1,
              states,
              specialty_packs,
              stripe_customer_id: sub.customer,
              stripe_subscription_id: sub.id,
              status: sub.status,
              current_period_start: new Date(sub.current_period_start * 1000),
              current_period_end: new Date(sub.current_period_end * 1000),
              trial_end: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
              cancel_at_period_end: sub.cancel_at_period_end,
            }),
          )
          .execute();
        return { tier, seats, status: sub.status, period_end: sub.current_period_end };
      }

      case 'invoice.payment_failed': {
        // Don't change status here — Stripe emits a subscription.updated
        // shortly after. We only flag it for telemetry.
        return { event: 'payment_failed', logged: true };
      }

      case 'invoice.paid': {
        return { event: 'invoice_paid', logged: true };
      }

      case 'invoice.uncollectible': {
        return { event: 'invoice_uncollectible', logged: true };
      }

      case 'checkout.session.completed':
      case 'checkout.session.expired': {
        // Checkout completion produces a follow-up
        // customer.subscription.created which is what actually applies
        // state. We log here for the audit/forensic trail.
        return { event: event.type, logged: true };
      }

      default:
        return { event: event.type, ignored: true };
    }
  }
}

function parseTier(s: string | undefined): SubscriptionTier {
  switch ((s ?? '').toLowerCase()) {
    case 'solo':
    case 'team':
    case 'org':
    case 'enterprise':
      return s!.toLowerCase() as SubscriptionTier;
    default:
      return 'team'; // safe default; webhook controller logs the fallback
  }
}

function parseList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}
