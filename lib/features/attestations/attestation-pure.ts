/**
 * Attestation pure helpers — expiry math, status derivation, query
 * predicates.
 *
 * No DB. The service layer reads attestation rows + asks these
 * helpers to bucket them for the UI (active / expiring soon /
 * expired) and to compute the canonical 90-day default expiry.
 *
 * Source: pallio_complete_vision_v3 §15.3 (90-day expiration with
 * reminders at 75, 85, 90 days).
 */

export const DEFAULT_ATTESTATION_DAYS = 90;
export const REMINDER_AT_DAYS_REMAINING = [15, 5, 0]; // §15.3 →
//   call_date + 75 days  → 15 remaining (15 days before expiry)
//   call_date + 85 days  → 5  remaining
//   call_date + 90 days  → 0  remaining

export type AttestationLifecycle =
  | "active"
  | "expired"
  | "voided"
  | "re_verified";

export type AttestationFreshness =
  | "fresh"          // > 30 days remaining
  | "expiring_soon"  // ≤ 30 days remaining
  | "due"            // ≤ 7 days remaining
  | "overdue";       // past expires_at

interface AttestationLike {
  status: AttestationLifecycle;
  expiresAt: Date | string;
}

/** Compute the default expiry for a phone-confirmed attestation. */
export function defaultExpiry(callDate: Date | string): Date {
  const d = new Date(callDate);
  return new Date(d.getTime() + DEFAULT_ATTESTATION_DAYS * 86_400_000);
}

/**
 * Days remaining until expiry. Negative when past.
 */
export function daysUntilExpiry(
  expiresAt: Date | string,
  today: Date = new Date(),
): number {
  const exp = startOfDayUtc(new Date(expiresAt));
  const now = startOfDayUtc(today);
  return Math.round((exp.getTime() - now.getTime()) / 86_400_000);
}

export function freshnessBucket(
  attestation: AttestationLike,
  today: Date = new Date(),
): AttestationFreshness {
  if (attestation.status !== "active") return "overdue";
  const remaining = daysUntilExpiry(attestation.expiresAt, today);
  if (remaining < 0) return "overdue";
  if (remaining <= 7) return "due";
  if (remaining <= 30) return "expiring_soon";
  return "fresh";
}

/**
 * True iff the row should fire a re-verification reminder today
 * (per the 75/85/90 schedule in §15.3). Service layer wires this
 * into the daily cron.
 */
export function shouldRemindToday(
  attestation: AttestationLike,
  today: Date = new Date(),
): boolean {
  if (attestation.status !== "active") return false;
  const remaining = daysUntilExpiry(attestation.expiresAt, today);
  return REMINDER_AT_DAYS_REMAINING.includes(remaining);
}

/**
 * Group attestations by freshness bucket — used by the queue dashboard.
 */
export function groupByFreshness<T extends AttestationLike>(
  rows: T[],
  today: Date = new Date(),
): Record<AttestationFreshness, T[]> {
  const out: Record<AttestationFreshness, T[]> = {
    fresh: [],
    expiring_soon: [],
    due: [],
    overdue: [],
  };
  for (const row of rows) {
    out[freshnessBucket(row, today)].push(row);
  }
  return out;
}

function startOfDayUtc(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
