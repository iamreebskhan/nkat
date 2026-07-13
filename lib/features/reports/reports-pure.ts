/**
 * Reports pure helpers — aggregations + bucketing + trend math.
 *
 * No DB. The service layer fetches raw rows; these helpers turn them
 * into chart-ready series. Unit-tested for off-by-one, empty-set, and
 * timezone bugs.
 */

export interface DenialRowLike {
  carcCode: string;
  payerId: string | null;
  cptCode: string;
  deniedAmountCents: number;
  decision: string;
  outcome: string;
  deniedAt: Date | string;
  /** The claim this denial is against — used to dedupe re-denials of the same claim. */
  superbillId: string | null;
}

export interface SuperbillRowLike {
  payerId: string | null;
  status: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
  dateOfService: Date | string;
}

export interface VisitRowLike {
  visitType: string;
  status: string;
  clinicianUserId: string;
  scheduledStart: Date | string | null;
  startTime: Date | string | null;
}

export interface DailyDataPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/**
 * Denial-rate trend (denied $ ÷ billed $) per day across a date range.
 * Aligned to UTC midnight day boundaries so the same series renders
 * the same anywhere.
 */
export function denialRateTrend(args: {
  superbills: SuperbillRowLike[];
  denials: DenialRowLike[];
  fromDate: Date;
  toDate: Date;
}): DailyDataPoint[] {
  const days = enumerateUtcDays(args.fromDate, args.toDate);
  const billedByDay = new Map<string, number>();
  const deniedByDay = new Map<string, number>();

  for (const sb of args.superbills) {
    const k = isoDay(sb.dateOfService);
    billedByDay.set(k, (billedByDay.get(k) ?? 0) + sb.billedAmountCents);
  }
  for (const d of args.denials) {
    const k = isoDay(d.deniedAt);
    deniedByDay.set(k, (deniedByDay.get(k) ?? 0) + d.deniedAmountCents);
  }

  return days.map((day) => {
    const billed = billedByDay.get(day) ?? 0;
    const denied = deniedByDay.get(day) ?? 0;
    // Percentage (0–100), clamped: a rate is bounded at 100%. Denials and
    // their originating superbills fall on different days (a claim is denied
    // days after billing), so per-day denied$/billed$ can spike past 100%
    // without the clamp — which reads as a broken metric rather than signal.
    const raw = billed > 0 ? (denied / billed) * 100 : 0;
    return { date: day, value: Math.round(Math.min(100, raw) * 100) / 100 };
  });
}

export interface DenialByPayer {
  payerId: string | null;
  /** Number of denial events (a re-denied claim counts each time). */
  count: number;
  deniedCents: number;
  /**
   * Denial rate for the payer, 0..1: DISTINCT claims denied ÷ claims
   * submitted, clamped. Deduping by claim keeps a claim that was denied,
   * refiled and denied again from inflating the rate past 100%.
   */
  rate: number;
}

export function denialsByPayer(args: {
  superbills: SuperbillRowLike[];
  denials: DenialRowLike[];
}): DenialByPayer[] {
  const byPayer = new Map<
    string | null,
    { count: number; deniedCents: number; submittedCount: number; deniedClaims: Set<string> }
  >();
  const ensure = (payerId: string | null) => {
    let e = byPayer.get(payerId);
    if (!e) { e = { count: 0, deniedCents: 0, submittedCount: 0, deniedClaims: new Set() }; byPayer.set(payerId, e); }
    return e;
  };
  for (const sb of args.superbills) {
    const e = ensure(sb.payerId);
    if (sb.status !== "draft" && sb.status !== "voided") e.submittedCount++;
  }
  for (const d of args.denials) {
    const e = ensure(d.payerId);
    e.count++;
    e.deniedCents += d.deniedAmountCents;
    // Distinct claims; fall back to a per-event key when superbillId is absent.
    e.deniedClaims.add(d.superbillId ?? `evt:${e.count}`);
  }
  return Array.from(byPayer.entries())
    .map(([payerId, v]) => ({
      payerId,
      count: v.count,
      deniedCents: v.deniedCents,
      rate: v.submittedCount > 0 ? Math.min(1, v.deniedClaims.size / v.submittedCount) : 0,
    }))
    .sort((a, b) => b.deniedCents - a.deniedCents);
}

export interface RevenueSummary {
  billedCents: number;
  paidCents: number;
  /** Cents in 'submitted' or later but not yet paid. */
  outstandingCents: number;
  /** paid / billed, 0..1. Zero when nothing billed. */
  collectionRate: number;
}

export function revenueSummary(superbills: SuperbillRowLike[]): RevenueSummary {
  let billed = 0;
  let paid = 0;
  let outstanding = 0;
  for (const sb of superbills) {
    billed += sb.billedAmountCents;
    paid += sb.paidAmountCents ?? 0;
    if (
      sb.status === "submitted" ||
      sb.status === "partially_paid"
    ) {
      outstanding += sb.billedAmountCents - (sb.paidAmountCents ?? 0);
    }
  }
  return {
    billedCents: billed,
    paidCents: paid,
    outstandingCents: outstanding,
    // Clamped [0,1] like the denial rate: an overpayment/recoupment can push
    // paid past billed, and a >100% "collection rate" reads as a broken metric.
    collectionRate: billed > 0 ? Math.min(1, paid / billed) : 0,
  };
}

/**
 * Visit volume by clinician — stacked bar source. Counts visits with
 * documented status or later (excludes scheduled / cancelled / no-show).
 */
export function visitVolumeByClinician(visits: VisitRowLike[]): {
  clinicianUserId: string;
  count: number;
}[] {
  const map = new Map<string, number>();
  for (const v of visits) {
    if (
      v.status === "scheduled" ||
      v.status === "cancelled" ||
      v.status === "no_show"
    ) {
      continue;
    }
    map.set(v.clinicianUserId, (map.get(v.clinicianUserId) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([clinicianUserId, count]) => ({ clinicianUserId, count }))
    .sort((a, b) => b.count - a.count);
}

export interface RuleCoverageSummary {
  total: number;
  confirmed: number;
  unknown: number;
  /** Confirmed / total, 0..1. */
  coverageRate: number;
}

/**
 * Rule coverage % across a rulebook — fraction of rows with a non-
 * unknown coverage status.
 */
export function ruleCoverage(rows: { coverageStatus: string }[]): RuleCoverageSummary {
  let confirmed = 0;
  let unknown = 0;
  for (const r of rows) {
    if (r.coverageStatus === "unknown") unknown++;
    else confirmed++;
  }
  const total = confirmed + unknown;
  return {
    total,
    confirmed,
    unknown,
    coverageRate: total > 0 ? confirmed / total : 0,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isoDay(d: Date | string): string {
  const x = new Date(d);
  return x.toISOString().slice(0, 10);
}

function enumerateUtcDays(from: Date, to: Date): string[] {
  const out: string[] = [];
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
