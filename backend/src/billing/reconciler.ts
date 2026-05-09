/**
 * Billing reconciler — pure logic.
 *
 * For an `invoice.paid` or `invoice.payment_failed` event, the webhook
 * controller logs the event but doesn't apply state — Stripe also emits
 * a follow-up `customer.subscription.updated`. This reconciler is the
 * belt-and-suspenders path that runs on a schedule and re-fetches every
 * subscription that has had an `invoice.*` event without a follow-up
 * `customer.subscription.*` within `staleSeconds`.
 *
 * Pure-ish: takes a list of `billing_event` rows + a clock + a fetcher
 * function, returns the set of `stripe_subscription_id`s that need
 * re-fetch. The orchestrator (a script or a Nest schedule) is responsible
 * for the actual API call + state apply.
 */
import type { StripeSubscriptionLike } from './billing-types';

export interface MinimalBillingEvent {
  org_id: string;
  event_type: string;
  occurred_at: Date;
  raw_payload: Record<string, unknown>;
}

export interface ReconcilerInput {
  events: MinimalBillingEvent[];
  /** Now used as the "is too stale to wait for the follow-up" cutoff. */
  nowMs: number;
  /** Seconds after which an unmatched invoice.* is considered stale. */
  staleSeconds: number;
}

export interface ReconcilerOutput {
  /** Map of org_id → stripe_subscription_id that needs a fresh fetch. */
  subscriptions_to_refetch: Array<{ org_id: string; stripe_subscription_id: string }>;
  reasons: Record<string, string>;
}

const INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_failed', 'invoice.uncollectible']);
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/**
 * Find invoice.* events older than `staleSeconds` for which there's NO
 * subsequent customer.subscription.* event for the same subscription_id.
 */
export function findStaleInvoiceEvents(input: ReconcilerInput): ReconcilerOutput {
  const nowMs = input.nowMs;
  const staleMs = input.staleSeconds * 1000;

  // Group by subscription_id.
  const bySub = new Map<
    string,
    { org_id: string; lastInvoice: Date | null; lastSubEvent: Date | null }
  >();

  for (const ev of input.events) {
    const subId = extractSubscriptionId(ev.raw_payload);
    if (!subId) continue;
    const slot = bySub.get(subId) ?? { org_id: ev.org_id, lastInvoice: null, lastSubEvent: null };
    if (INVOICE_EVENTS.has(ev.event_type)) {
      if (!slot.lastInvoice || ev.occurred_at > slot.lastInvoice) {
        slot.lastInvoice = ev.occurred_at;
      }
    } else if (SUBSCRIPTION_EVENTS.has(ev.event_type)) {
      if (!slot.lastSubEvent || ev.occurred_at > slot.lastSubEvent) {
        slot.lastSubEvent = ev.occurred_at;
      }
    }
    bySub.set(subId, slot);
  }

  const subscriptions_to_refetch: ReconcilerOutput['subscriptions_to_refetch'] = [];
  const reasons: Record<string, string> = {};

  for (const [subId, slot] of bySub.entries()) {
    if (!slot.lastInvoice) continue;
    const ageMs = nowMs - slot.lastInvoice.getTime();
    if (ageMs < staleMs) continue;
    if (slot.lastSubEvent && slot.lastSubEvent.getTime() >= slot.lastInvoice.getTime()) {
      // Subscription event arrived after the invoice — already reconciled.
      continue;
    }
    subscriptions_to_refetch.push({ org_id: slot.org_id, stripe_subscription_id: subId });
    reasons[subId] = `invoice age ${Math.round(ageMs / 1000)}s, no follow-up subscription event`;
  }

  return { subscriptions_to_refetch, reasons };
}

/**
 * Inspect a Stripe event payload's nested subscription identifier.
 * Stripe puts it in different places depending on the event type.
 */
function extractSubscriptionId(raw: Record<string, unknown>): string | null {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const obj = (data.object ?? {}) as Record<string, unknown>;
  // customer.subscription.* → object IS the subscription
  if (
    typeof obj.id === 'string' &&
    (obj.object === 'subscription' ||
      raw.type === 'customer.subscription.created' ||
      raw.type === 'customer.subscription.updated' ||
      raw.type === 'customer.subscription.deleted')
  ) {
    if (
      obj.object === 'subscription' ||
      (typeof raw.type === 'string' && (raw.type as string).startsWith('customer.subscription.'))
    ) {
      return String(obj.id);
    }
  }
  // invoice.* → object.subscription
  if (typeof obj.subscription === 'string') return obj.subscription;
  return null;
}

/**
 * Visible for tests: build an "apply this fresh subscription" plan from a
 * raw `StripeSubscriptionLike`. The reconciler controller will call
 * BillingService.ingestEvent with a synthetic event to walk the same
 * code path the webhook does.
 */
export function buildSyntheticReconcileEvent(
  _orgId: string,
  sub: StripeSubscriptionLike,
  nowMs: number,
): { id: string; type: string; created: number; data: { object: StripeSubscriptionLike } } {
  return {
    id: `evt_reconciled_${sub.id}_${Math.floor(nowMs / 1000)}`,
    type: 'customer.subscription.updated',
    created: Math.floor(nowMs / 1000),
    data: { object: sub },
  };
}
