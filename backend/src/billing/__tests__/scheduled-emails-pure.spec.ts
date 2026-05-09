import {
  planDunningEmails,
  planTrialEndingEmails,
  type SubscriptionSnapshot,
} from '../scheduled-emails-pure';

const NOW = new Date('2026-05-06T00:00:00Z').getTime();
const ORG = '11111111-1111-4111-8111-111111111111';

function sub(overrides: Partial<SubscriptionSnapshot>): SubscriptionSnapshot {
  return {
    org_id: ORG,
    org_name: 'Acme',
    status: 'trialing',
    tier: 'team',
    trial_end: null,
    current_period_end: null,
    primary_contact_email: 'admin@acme.com',
    ...overrides,
  };
}

describe('planTrialEndingEmails', () => {
  it('skips non-trialing subscriptions', () => {
    expect(planTrialEndingEmails([sub({ status: 'active' })], 'https://app', NOW)).toEqual([]);
  });

  it('skips subs with no trial_end', () => {
    expect(planTrialEndingEmails([sub({ trial_end: null })], 'https://app', NOW)).toEqual([]);
  });

  it('skips subs where trial already ended', () => {
    expect(
      planTrialEndingEmails(
        [sub({ trial_end: new Date(NOW - 24 * 3600 * 1000) })],
        'https://app',
        NOW,
      ),
    ).toEqual([]);
  });

  it.each([
    [1, 1], // 1 day left → window 1
    [2, 3], // 2 days left → window 3
    [3, 3], // 3 days left → window 3
    [4, 7], // 4 days left → window 7
    [7, 7], // 7 days left → window 7
  ])('days_left %d → window %d', (daysLeft, expectedWindow) => {
    const trial_end = new Date(NOW + daysLeft * 86_400_000);
    const r = planTrialEndingEmails([sub({ trial_end })], 'https://app', NOW);
    expect(r).toHaveLength(1);
    expect(r[0].args.days_left).toBe(daysLeft);
    expect(r[0].idempotencyKey).toMatch(new RegExp(`-w${expectedWindow}-`));
  });

  it('produces no email for daysLeft > 7', () => {
    expect(
      planTrialEndingEmails(
        [sub({ trial_end: new Date(NOW + 14 * 86_400_000) })],
        'https://app',
        NOW,
      ),
    ).toEqual([]);
  });

  it('skips when primary_contact_email is null', () => {
    expect(
      planTrialEndingEmails(
        [sub({ trial_end: new Date(NOW + 86_400_000), primary_contact_email: null })],
        'https://app',
        NOW,
      ),
    ).toEqual([]);
  });

  it('idempotency key includes org_id + window + day-bucket', () => {
    const r = planTrialEndingEmails(
      [sub({ trial_end: new Date(NOW + 3 * 86_400_000) })],
      'https://app',
      NOW,
    );
    expect(r[0].idempotencyKey).toBe(`trial-${ORG}-w3-d3`);
  });
});

describe('planDunningEmails', () => {
  it('emits exactly one dunning email per past_due sub', () => {
    const r = planDunningEmails([sub({ status: 'past_due' })], 'https://app', NOW);
    expect(r).toHaveLength(1);
    expect(r[0].template).toBe('dunning_past_due');
    expect(r[0].args.manage_url).toBe('https://app/billing');
  });

  it('skips non-past_due statuses', () => {
    expect(planDunningEmails([sub({ status: 'active' })], 'https://app', NOW)).toEqual([]);
    expect(planDunningEmails([sub({ status: 'trialing' })], 'https://app', NOW)).toEqual([]);
  });

  it('idempotency key buckets on day, so daily re-runs are no-ops', () => {
    const r1 = planDunningEmails([sub({ status: 'past_due' })], 'https://app', NOW);
    const r2 = planDunningEmails([sub({ status: 'past_due' })], 'https://app', NOW + 60_000);
    expect(r1[0].idempotencyKey).toBe(r2[0].idempotencyKey);
  });

  it('skips when primary_contact_email is null', () => {
    expect(
      planDunningEmails(
        [sub({ status: 'past_due', primary_contact_email: null })],
        'https://app',
        NOW,
      ),
    ).toEqual([]);
  });
});
