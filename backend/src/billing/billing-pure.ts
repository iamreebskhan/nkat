/**
 * Pure functions extracted from BillingService for direct unit testing.
 * No DB, no Stripe, no Nest — just inputs → outputs.
 *
 * The service uses these; integration tests exercise the DB orchestration
 * separately. This split keeps the unit-test surface deterministic.
 */
import type { StripeEventLike, StripeSubscriptionLike, SubscriptionTier } from './billing-types';

export function parseTier(s: string | undefined | null): SubscriptionTier {
  switch ((s ?? '').toLowerCase()) {
    case 'solo':
    case 'team':
    case 'org':
    case 'enterprise':
      return s!.toLowerCase() as SubscriptionTier;
    default:
      return 'team';
  }
}

export function parseList(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export interface ComputedSubscriptionState {
  tier: SubscriptionTier;
  seats: number;
  states: string[];
  specialty_packs: string[];
  status: StripeSubscriptionLike['status'];
  current_period_start: Date;
  current_period_end: Date;
  trial_end: Date | null;
  cancel_at_period_end: boolean;
}

export function computeSubscriptionState(sub: StripeSubscriptionLike): ComputedSubscriptionState {
  const seatsRaw = parseInt(sub.metadata.seats ?? '0', 10);
  return {
    tier: parseTier(sub.metadata.tier),
    seats: seatsRaw > 0 ? seatsRaw : 1,
    states: parseList(sub.metadata.states),
    specialty_packs: parseList(sub.metadata.specialty_packs),
    status: sub.status,
    current_period_start: new Date(sub.current_period_start * 1000),
    current_period_end: new Date(sub.current_period_end * 1000),
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    cancel_at_period_end: sub.cancel_at_period_end,
  };
}

export type EventOutcome =
  | { kind: 'apply'; state: ComputedSubscriptionState }
  | { kind: 'log'; event: string }
  | { kind: 'ignore'; event: string };

export function classifyEvent(
  event: StripeEventLike,
  sub: StripeSubscriptionLike | null,
): EventOutcome {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      if (!sub) return { kind: 'ignore', event: event.type };
      return { kind: 'apply', state: computeSubscriptionState(sub) };
    case 'invoice.payment_failed':
    case 'invoice.paid':
    case 'invoice.uncollectible':
    case 'checkout.session.completed':
    case 'checkout.session.expired':
      return { kind: 'log', event: event.type };
    default:
      return { kind: 'ignore', event: event.type };
  }
}
