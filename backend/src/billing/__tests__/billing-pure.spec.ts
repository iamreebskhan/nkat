import { classifyEvent, computeSubscriptionState, parseList, parseTier } from '../billing-pure';
import type { StripeEventLike, StripeSubscriptionLike } from '../billing-types';

const NOW = 1_700_000_000;

const baseSub: StripeSubscriptionLike = {
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  current_period_start: NOW,
  current_period_end: NOW + 30 * 24 * 3600,
  trial_end: null,
  cancel_at_period_end: false,
  metadata: {
    org_id: '11111111-1111-4111-8111-111111111111',
    tier: 'org',
    seats: '15',
    states: 'OH, NC,SC',
    specialty_packs: 'palliative,oncology',
  },
};

describe('parseTier', () => {
  it.each([
    ['solo', 'solo'],
    ['Team', 'team'],
    ['ORG', 'org'],
    ['enterprise', 'enterprise'],
  ])('canonicalizes %s → %s', (input, expected) => {
    expect(parseTier(input)).toBe(expected);
  });

  it('falls back to team on missing/garbage values', () => {
    expect(parseTier(undefined)).toBe('team');
    expect(parseTier('')).toBe('team');
    expect(parseTier('platinum-plus')).toBe('team');
  });
});

describe('parseList', () => {
  it('splits CSV with surrounding whitespace tolerated', () => {
    expect(parseList(' OH, NC,  SC  ')).toEqual(['OH', 'NC', 'SC']);
  });
  it('returns [] for empty / null', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList(null)).toEqual([]);
  });
  it('drops empty entries', () => {
    expect(parseList('OH,,NC,')).toEqual(['OH', 'NC']);
  });
});

describe('computeSubscriptionState', () => {
  it('translates a happy-path subscription', () => {
    const s = computeSubscriptionState(baseSub);
    expect(s.tier).toBe('org');
    expect(s.seats).toBe(15);
    expect(s.states).toEqual(['OH', 'NC', 'SC']);
    expect(s.specialty_packs).toEqual(['palliative', 'oncology']);
    expect(s.current_period_start).toEqual(new Date(NOW * 1000));
    expect(s.trial_end).toBeNull();
    expect(s.cancel_at_period_end).toBe(false);
  });

  it('coerces seats < 1 to 1 (defensive)', () => {
    const s = computeSubscriptionState({
      ...baseSub,
      metadata: { ...baseSub.metadata, seats: '0' },
    });
    expect(s.seats).toBe(1);
  });

  it('handles non-numeric seats by falling back to 1', () => {
    const s = computeSubscriptionState({
      ...baseSub,
      metadata: { ...baseSub.metadata, seats: 'unlimited' },
    });
    expect(s.seats).toBe(1);
  });

  it('preserves trial_end when present', () => {
    const trialEnd = NOW + 14 * 24 * 3600;
    const s = computeSubscriptionState({ ...baseSub, trial_end: trialEnd });
    expect(s.trial_end).toEqual(new Date(trialEnd * 1000));
  });
});

describe('classifyEvent', () => {
  function evt(type: string): StripeEventLike {
    return { id: 'evt_x', type, created: NOW, data: { object: baseSub } };
  }

  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])('apply path: %s with subscription', (type) => {
    const r = classifyEvent(evt(type), baseSub);
    expect(r.kind).toBe('apply');
    if (r.kind === 'apply') {
      expect(r.state.tier).toBe('org');
    }
  });

  it('subscription event without payload is ignored, not crashed', () => {
    const r = classifyEvent(evt('customer.subscription.updated'), null);
    expect(r.kind).toBe('ignore');
  });

  it.each([
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.uncollectible',
    'checkout.session.completed',
    'checkout.session.expired',
  ])('log path: %s', (type) => {
    const r = classifyEvent(evt(type), null);
    expect(r.kind).toBe('log');
  });

  it('unknown event types are ignored', () => {
    const r = classifyEvent(evt('charge.captured'), null);
    expect(r.kind).toBe('ignore');
  });
});
