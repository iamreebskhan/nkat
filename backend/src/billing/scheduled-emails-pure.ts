/**
 * Scheduled-email candidate selectors. Given a snapshot of subscription
 * rows + a clock, returns the list of `(orgId, template, idempotencyKey)`
 * triples to send. Pure: no DB, no network, no clock-of-its-own.
 *
 * The scheduler script is the orchestrator (DB read → these functions →
 * EmailService.send).
 */
import type { SubscriptionStatus, SubscriptionTier } from '../database/schema.types';
import type { EmailTemplate } from '../email/email-types';

export interface SubscriptionSnapshot {
  org_id: string;
  org_name: string;
  status: SubscriptionStatus;
  tier: SubscriptionTier;
  trial_end: Date | null;
  current_period_end: Date | null;
  primary_contact_email: string | null;
}

export interface EmailPlan<T extends EmailTemplate = EmailTemplate> {
  org_id: string;
  to: string;
  template: T;
  // Untyped on purpose at the orchestration layer — the script renders
  // the args from the DB row before handing to EmailService.
  args: Record<string, unknown>;
  /** Stable idempotency key — same key → no double-send across runs. */
  idempotencyKey: string;
}

/**
 * Trial-ending: send when `trial_end` falls inside the next windowDays.
 * Bucket the days_left to the smallest window so we send at most one
 * trial-ending email per (org, day-bucket).
 *
 * Default windows: 1, 3, 7 — a customer ends up with up to three
 * notifications across the trial. The list is sorted ascending so
 * `find(daysLeft <= w)` picks the SMALLEST window the customer is
 * currently inside; urgency increases as the trial approaches end.
 */
const TRIAL_WINDOWS = [1, 3, 7];

export function planTrialEndingEmails(
  subs: SubscriptionSnapshot[],
  appUrl: string,
  nowMs: number,
): EmailPlan<'trial_ending'>[] {
  const out: EmailPlan<'trial_ending'>[] = [];
  for (const s of subs) {
    if (s.status !== 'trialing') continue;
    if (!s.trial_end) continue;
    if (!s.primary_contact_email) continue;
    const daysLeft = Math.ceil((s.trial_end.getTime() - nowMs) / 86_400_000);
    if (daysLeft <= 0) continue;
    // Choose the smallest window the customer is currently inside.
    const window = TRIAL_WINDOWS.find((w) => daysLeft <= w);
    if (!window) continue;
    // Bucket on the calendar day so daily re-runs are idempotent
    // within a window.
    const dayBucket = Math.floor(s.trial_end.getTime() / 86_400_000) - Math.floor(nowMs / 86_400_000);
    out.push({
      org_id: s.org_id,
      to: s.primary_contact_email,
      template: 'trial_ending',
      args: {
        org_name: s.org_name,
        days_left: daysLeft,
        manage_url: `${appUrl.replace(/\/$/, '')}/billing`,
      },
      idempotencyKey: `trial-${s.org_id}-w${window}-d${dayBucket}`,
    });
  }
  return out;
}

/**
 * Dunning: send when status is 'past_due'. Idempotency keyed on the
 * day so we don't spam — at most one dunning email per (org, day).
 */
export function planDunningEmails(
  subs: SubscriptionSnapshot[],
  appUrl: string,
  nowMs: number,
): EmailPlan<'dunning_past_due'>[] {
  const out: EmailPlan<'dunning_past_due'>[] = [];
  const today = Math.floor(nowMs / 86_400_000);
  for (const s of subs) {
    if (s.status !== 'past_due') continue;
    if (!s.primary_contact_email) continue;
    out.push({
      org_id: s.org_id,
      to: s.primary_contact_email,
      template: 'dunning_past_due',
      args: {
        org_name: s.org_name,
        manage_url: `${appUrl.replace(/\/$/, '')}/billing`,
      },
      idempotencyKey: `dunning-${s.org_id}-d${today}`,
    });
  }
  return out;
}
