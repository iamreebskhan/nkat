/**
 * Billing types — the closed enums + payload shapes that govern the
 * Stripe-backed subscription lifecycle.
 *
 * The Stripe SDK is NOT imported anywhere outside `stripe-client.ts`; the
 * rest of the module talks to a thin abstract `StripeClient` interface so
 * unit tests stub the network without pulling Stripe into Jest.
 */
import type { SubscriptionStatus, SubscriptionTier } from '../database/schema.types';

export type { SubscriptionStatus, SubscriptionTier };

export const TIER_DEFAULTS: Record<
  SubscriptionTier,
  { seats: number; price_per_seat_usd: number }
> = {
  solo: { seats: 1, price_per_seat_usd: 79 },
  team: { seats: 10, price_per_seat_usd: 69 },
  org: { seats: 100, price_per_seat_usd: 59 },
  enterprise: { seats: 999, price_per_seat_usd: 0 /* contracted */ },
};

export const ALL_SPECIALTY_PACKS = [
  'palliative',
  'behavioral_health',
  'oncology',
  'dme',
  'wc',
  'ihs',
  'asc',
  'hcc',
] as const;

export type SpecialtyPack = (typeof ALL_SPECIALTY_PACKS)[number];

/** A subset of the Stripe Subscription object — only the fields we read. */
export interface StripeSubscriptionLike {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  current_period_start: number; // unix seconds
  current_period_end: number; // unix seconds
  trial_end: number | null;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
}

/** A subset of the Stripe Event object — only the fields we route on. */
export interface StripeEventLike {
  id: string; // evt_...
  type: string; // customer.subscription.updated, invoice.paid, ...
  created: number; // unix seconds
  data: { object: unknown };
}

/** Abstract Stripe client surface. Production wiring uses the SDK adapter. */
export interface StripeClient {
  /** Verify the Stripe-Signature header and return the parsed event. */
  constructEvent(rawBody: string, signatureHeader: string): StripeEventLike;
  retrieveSubscription(id: string): Promise<StripeSubscriptionLike>;
  createPortalSession?(args: {
    customerId: string;
    returnUrl: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string; expires_at: number }>;
  createCheckoutSession?(args: {
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    orgId: string;
    tier: string;
    states?: string[];
    specialty_packs?: string[];
    trialDays?: number;
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string }>;
  updateSubscriptionSeats?(args: {
    subscriptionId: string;
    subscriptionItemId: string;
    quantity: number;
    prorate?: boolean;
    idempotencyKey?: string;
  }): Promise<StripeSubscriptionLike>;
}

export class InvalidWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookSignatureError';
  }
}
