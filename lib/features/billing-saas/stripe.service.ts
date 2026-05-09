/**
 * Stripe billing service — checkout sessions, webhook handler, plan tracking.
 *
 * Source: pallio_complete_vision_v3 §6.8 + §13 (pricing tiers).
 *
 * Tiers:
 *   solo       — 1 seat
 *   team       — 5 seats
 *   org        — 25 seats
 *   enterprise — custom
 *
 * Flow:
 *   1. /api/billing/checkout creates a Stripe Checkout Session.
 *   2. Customer completes payment on stripe.com.
 *   3. Stripe POSTs to /api/webhooks/stripe.
 *   4. Webhook handler verifies signature, upserts the `subscription` row,
 *      logs the full event payload to `billing_event` (forensic store).
 *
 * Stripe is the source of truth for billing state; the `subscription`
 * table is a cache for low-latency reads + RLS-bounded queries.
 */
import Stripe from "stripe";

import { withOrgContext } from "@/lib/db";
import { env } from "@/lib/env";

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = env().STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set. Billing endpoints are disabled.");
  }
  _stripe = new Stripe(key, {
    // Pin the API version so payload shape is stable across SDK upgrades.
    apiVersion: "2025-02-24.acacia",
  });
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return Boolean(env().STRIPE_SECRET_KEY);
}

export type Tier = "solo" | "team" | "org" | "enterprise";

export interface PlanCatalogEntry {
  tier: Tier;
  /** Stripe price ID — set at deploy time per environment. */
  stripePriceId: string;
  seats: number;
  monthlyUsd: number;
  /** Marketing label. */
  label: string;
}

/**
 * Catalog. In prod the price IDs come from env; here we expose a typed
 * shape so the checkout endpoint can validate the requested tier before
 * hitting Stripe.
 */
export function planCatalog(): PlanCatalogEntry[] {
  return [
    { tier: "solo",       stripePriceId: process.env.STRIPE_PRICE_SOLO ?? "price_solo_dev",       seats: 1,  monthlyUsd: 79,  label: "Solo" },
    { tier: "team",       stripePriceId: process.env.STRIPE_PRICE_TEAM ?? "price_team_dev",       seats: 5,  monthlyUsd: 299, label: "Team" },
    { tier: "org",        stripePriceId: process.env.STRIPE_PRICE_ORG ?? "price_org_dev",         seats: 25, monthlyUsd: 999, label: "Organization" },
    { tier: "enterprise", stripePriceId: process.env.STRIPE_PRICE_ENT ?? "price_enterprise_dev", seats: 0,  monthlyUsd: 0,   label: "Enterprise (custom)" },
  ];
}

export interface CreateCheckoutInput {
  orgId: string;
  userEmail: string;
  tier: Tier;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Create a Stripe Checkout Session. Returns the redirect URL.
 * Reuses an existing customer if the org already has stripe_customer_id.
 */
export async function createCheckoutSession(
  input: CreateCheckoutInput,
): Promise<{ url: string }> {
  if (input.tier === "enterprise") {
    throw new Error("Enterprise plans are sales-led — see /contact.");
  }
  const plan = planCatalog().find((p) => p.tier === input.tier);
  if (!plan) throw new Error(`Unknown tier: ${input.tier}`);

  const customerId = await ensureStripeCustomer(input.orgId, input.userEmail);

  const s = stripe();
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    subscription_data: {
      metadata: { org_id: input.orgId, tier: input.tier },
    },
    metadata: { org_id: input.orgId, tier: input.tier },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }
  return { url: session.url };
}

async function ensureStripeCustomer(orgId: string, email: string): Promise<string> {
  const cached = await withOrgContext(orgId, async (tx) => {
    const r = await tx.$queryRaw<{ stripe_customer_id: string | null }[]>`
      SELECT stripe_customer_id FROM subscription WHERE org_id = ${orgId}::uuid LIMIT 1
    `;
    return r[0]?.stripe_customer_id ?? null;
  });
  if (cached) return cached;

  const s = stripe();
  const cust = await s.customers.create({
    email,
    metadata: { org_id: orgId },
  });
  return cust.id;
}

/**
 * Webhook handler — verify signature, dispatch on event.type, upsert
 * the cached subscription row.
 *
 * Returns the event id even on no-op (Stripe wants a 2xx in <30s).
 */
export async function handleStripeWebhook(args: {
  signature: string;
  rawBody: string;
}): Promise<{ id: string; handled: boolean }> {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
  }
  const event = stripe().webhooks.constructEvent(args.rawBody, args.signature, secret);

  // Forensic log first — even if dispatch later throws, we have the payload.
  await logBillingEvent(event);

  let handled = true;
  switch (event.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscriptionFromEvent(event);
      break;
    default:
      handled = false;
  }
  return { id: event.id, handled };
}

async function logBillingEvent(event: Stripe.Event): Promise<void> {
  const orgId = extractOrgId(event);
  if (!orgId) return; // event with no org_id (e.g. account events) — skip log.
  await withOrgContext(orgId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO billing_event (org_id, stripe_event_id, event_type, payload, received_at)
      VALUES (${orgId}::uuid, ${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb, now())
      ON CONFLICT (stripe_event_id) DO NOTHING
    `;
  });
}

async function syncSubscriptionFromEvent(event: Stripe.Event): Promise<void> {
  const orgId = extractOrgId(event);
  if (!orgId) return;

  // Resolve the active subscription object regardless of event shape.
  let sub: Stripe.Subscription | null = null;
  if (event.data.object && (event.data.object as { object?: string }).object === "subscription") {
    sub = event.data.object as Stripe.Subscription;
  } else if (event.type === "checkout.session.completed") {
    const sess = event.data.object as Stripe.Checkout.Session;
    if (typeof sess.subscription === "string") {
      sub = await stripe().subscriptions.retrieve(sess.subscription);
    }
  }
  if (!sub) return;

  const tier =
    (sub.metadata?.tier as Tier | undefined) ??
    (sub.items.data[0]?.price.metadata?.tier as Tier | undefined) ??
    "solo";
  const plan = planCatalog().find((p) => p.tier === tier);
  const seats = plan?.seats ?? 1;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  await withOrgContext(orgId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO subscription (
        org_id, tier, seats, stripe_customer_id, stripe_subscription_id,
        status, current_period_start, current_period_end, trial_end,
        cancel_at_period_end
      ) VALUES (
        ${orgId}::uuid, ${tier}, ${seats}, ${customerId}, ${sub.id},
        ${sub.status},
        ${tsToDate(sub.current_period_start)},
        ${tsToDate(sub.current_period_end)},
        ${tsToDate(sub.trial_end)},
        ${sub.cancel_at_period_end ?? false}
      )
      ON CONFLICT (org_id) DO UPDATE SET
        tier = EXCLUDED.tier,
        seats = EXCLUDED.seats,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        status = EXCLUDED.status,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        trial_end = EXCLUDED.trial_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = now()
    `;
  });
}

function extractOrgId(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string> };
  const fromObj = obj.metadata?.org_id;
  if (fromObj) return fromObj;
  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    return sub.metadata?.org_id ?? null;
  }
  return null;
}

function tsToDate(unixSeconds: number | null | undefined): Date | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000);
}
