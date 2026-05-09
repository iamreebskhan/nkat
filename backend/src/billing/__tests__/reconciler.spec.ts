import {
  findStaleInvoiceEvents,
  buildSyntheticReconcileEvent,
  type MinimalBillingEvent,
} from '../reconciler';
import type { StripeSubscriptionLike } from '../billing-types';

const ORG = '11111111-1111-4111-8111-111111111111';
const SUB = 'sub_1';

function ev(type: string, ageSec: number, payload?: Record<string, unknown>): MinimalBillingEvent {
  return {
    org_id: ORG,
    event_type: type,
    occurred_at: new Date(Date.now() - ageSec * 1000),
    raw_payload: payload ?? {
      type,
      data: {
        object: type.startsWith('customer.subscription.')
          ? { id: SUB, object: 'subscription' }
          : { subscription: SUB },
      },
    },
  };
}

describe('findStaleInvoiceEvents', () => {
  it('flags an invoice with no follow-up subscription event past staleSeconds', () => {
    const out = findStaleInvoiceEvents({
      events: [ev('invoice.paid', 600)],
      nowMs: Date.now(),
      staleSeconds: 300,
    });
    expect(out.subscriptions_to_refetch).toHaveLength(1);
    expect(out.subscriptions_to_refetch[0].stripe_subscription_id).toBe(SUB);
    expect(out.subscriptions_to_refetch[0].org_id).toBe(ORG);
    expect(out.reasons[SUB]).toMatch(/no follow-up/);
  });

  it('does NOT flag when a subscription event arrived after the invoice', () => {
    const out = findStaleInvoiceEvents({
      events: [ev('invoice.paid', 600), ev('customer.subscription.updated', 120)],
      nowMs: Date.now(),
      staleSeconds: 300,
    });
    expect(out.subscriptions_to_refetch).toHaveLength(0);
  });

  it('does NOT flag when the invoice is younger than staleSeconds', () => {
    const out = findStaleInvoiceEvents({
      events: [ev('invoice.paid', 60)],
      nowMs: Date.now(),
      staleSeconds: 300,
    });
    expect(out.subscriptions_to_refetch).toHaveLength(0);
  });

  it('flags invoice.payment_failed and invoice.uncollectible too', () => {
    const out = findStaleInvoiceEvents({
      events: [
        ev('invoice.payment_failed', 600),
        ev('invoice.uncollectible', 600, {
          type: 'invoice.uncollectible',
          data: { object: { subscription: 'sub_2' } },
        }),
      ],
      nowMs: Date.now(),
      staleSeconds: 300,
    });
    expect(out.subscriptions_to_refetch.map((x) => x.stripe_subscription_id).sort()).toEqual([
      'sub_1',
      'sub_2',
    ]);
  });

  it('groups events per subscription correctly', () => {
    const out = findStaleInvoiceEvents({
      events: [
        ev('invoice.paid', 600), // sub_1, stale
        ev('customer.subscription.updated', 1200, {
          // sub_1 BEFORE invoice — doesn't count as follow-up
          type: 'customer.subscription.updated',
          data: { object: { id: 'sub_1', object: 'subscription' } },
        }),
      ],
      nowMs: Date.now(),
      staleSeconds: 300,
    });
    expect(out.subscriptions_to_refetch.map((x) => x.stripe_subscription_id)).toEqual(['sub_1']);
  });

  it('ignores events without a resolvable subscription id', () => {
    const out = findStaleInvoiceEvents({
      events: [
        { org_id: ORG, event_type: 'charge.captured', occurred_at: new Date(), raw_payload: {} },
      ],
      nowMs: Date.now(),
      staleSeconds: 300,
    });
    expect(out.subscriptions_to_refetch).toHaveLength(0);
  });
});

describe('buildSyntheticReconcileEvent', () => {
  it('produces a subscription.updated event the BillingService can ingest', () => {
    const sub: StripeSubscriptionLike = {
      id: 'sub_x',
      customer: 'cus_x',
      status: 'active',
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      trial_end: null,
      cancel_at_period_end: false,
      metadata: { org_id: ORG, tier: 'team', seats: '5' },
    };
    const e = buildSyntheticReconcileEvent(ORG, sub, 1_703_000_000_000);
    expect(e.type).toBe('customer.subscription.updated');
    expect(e.id).toMatch(/^evt_reconciled_sub_x_/);
    expect(e.data.object).toBe(sub);
  });
});
