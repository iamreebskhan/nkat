/**
 * Billing overview — the numbers behind the Billing dashboard.
 *
 * Client walkthrough [03:23]: "poora dashboard banega billing ka, jahan pe
 * humare paas saare record ho — ke kis client ke kya cheezein chal rahi hain,
 * kis nurse ne jo hai, kaun kitne bills jo hain, woh kya hai — submit wagera."
 *   → what's happening per client, per nurse, how many bills, what state
 *     they're in.
 *
 * All reads are tenant-scoped through withOrgContext.
 */
import { withOrgContext } from "@/lib/db";

export interface BillingTotals {
  draft: number;
  readyToSubmit: number;
  submitted: number;
  paid: number;
  partiallyPaid: number;
  denied: number;
  voided: number;
  billedCents: number;
  paidCents: number;
  /** Submitted or partially paid but not yet settled. */
  outstandingCents: number;
  /** Denied and not yet corrected — the work queue. */
  needsAttention: number;
}

export interface BillingByClient {
  patientId: string;
  patientName: string;
  payerName: string | null;
  bills: number;
  billedCents: number;
  paidCents: number;
  deniedCount: number;
  lastActivityAt: string | null;
}

export interface BillingByNurse {
  clinicianUserId: string;
  clinicianName: string | null;
  bills: number;
  submitted: number;
  paid: number;
  denied: number;
  billedCents: number;
}

export interface BillingOverview {
  totals: BillingTotals;
  byClient: BillingByClient[];
  byNurse: BillingByNurse[];
}

export async function getBillingOverview(args: {
  orgId: string;
  limit?: number;
}): Promise<BillingOverview> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 25));

  return withOrgContext(args.orgId, async (tx) => {
    const totalsRows = await tx.$queryRaw<
      {
        draft: bigint;
        ready_to_submit: bigint;
        submitted: bigint;
        paid: bigint;
        partially_paid: bigint;
        denied: bigint;
        voided: bigint;
        billed_cents: bigint | null;
        paid_cents: bigint | null;
        outstanding_cents: bigint | null;
      }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE status = 'draft')           AS draft,
        COUNT(*) FILTER (WHERE status = 'ready_to_submit') AS ready_to_submit,
        COUNT(*) FILTER (WHERE status = 'submitted')       AS submitted,
        COUNT(*) FILTER (WHERE status = 'paid')            AS paid,
        COUNT(*) FILTER (WHERE status = 'partially_paid')  AS partially_paid,
        COUNT(*) FILTER (WHERE status = 'denied')          AS denied,
        COUNT(*) FILTER (WHERE status = 'voided')          AS voided,
        COALESCE(SUM(billed_amount_cents), 0)              AS billed_cents,
        COALESCE(SUM(paid_amount_cents), 0)                AS paid_cents,
        COALESCE(SUM(billed_amount_cents - COALESCE(paid_amount_cents, 0))
                 FILTER (WHERE status IN ('submitted', 'partially_paid')), 0) AS outstanding_cents
      FROM superbill
    `;
    const t = totalsRows[0]!;

    const byClient = await tx.$queryRaw<
      {
        patient_id: string;
        patient_name: string;
        payer_name: string | null;
        bills: bigint;
        billed_cents: bigint | null;
        paid_cents: bigint | null;
        denied_count: bigint;
        last_activity_at: Date | null;
      }[]
    >`
      SELECT s.patient_id,
             TRIM(p.first_name || ' ' || p.last_name) AS patient_name,
             pay.name AS payer_name,
             COUNT(*)                                  AS bills,
             COALESCE(SUM(s.billed_amount_cents), 0)   AS billed_cents,
             COALESCE(SUM(s.paid_amount_cents), 0)     AS paid_cents,
             COUNT(*) FILTER (WHERE s.status = 'denied') AS denied_count,
             MAX(s.updated_at)                         AS last_activity_at
      FROM superbill s
      JOIN patient p ON p.id = s.patient_id
      LEFT JOIN payer pay ON pay.id = s.payer_id
      GROUP BY s.patient_id, p.first_name, p.last_name, pay.name
      ORDER BY MAX(s.updated_at) DESC NULLS LAST
      LIMIT ${limit}
    `;

    // Attribution is via the visit's clinician — that's who did the work the
    // bill represents ("kis nurse ne kitne bills").
    const byNurse = await tx.$queryRaw<
      {
        clinician_user_id: string;
        clinician_name: string | null;
        bills: bigint;
        submitted: bigint;
        paid: bigint;
        denied: bigint;
        billed_cents: bigint | null;
      }[]
    >`
      SELECT v.clinician_user_id,
             COALESCE(u.full_name, u.email) AS clinician_name,
             COUNT(*)                       AS bills,
             COUNT(*) FILTER (WHERE s.status IN ('submitted', 'paid', 'partially_paid')) AS submitted,
             COUNT(*) FILTER (WHERE s.status = 'paid')   AS paid,
             COUNT(*) FILTER (WHERE s.status = 'denied') AS denied,
             COALESCE(SUM(s.billed_amount_cents), 0)     AS billed_cents
      FROM superbill s
      JOIN visit v ON v.id = s.visit_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      GROUP BY v.clinician_user_id, u.full_name, u.email
      ORDER BY COUNT(*) DESC
      LIMIT ${limit}
    `;

    const n = (v: bigint | null) => Number(v ?? 0);

    return {
      totals: {
        draft: n(t.draft),
        readyToSubmit: n(t.ready_to_submit),
        submitted: n(t.submitted),
        paid: n(t.paid),
        partiallyPaid: n(t.partially_paid),
        denied: n(t.denied),
        voided: n(t.voided),
        billedCents: n(t.billed_cents),
        paidCents: n(t.paid_cents),
        outstandingCents: n(t.outstanding_cents),
        needsAttention: n(t.denied),
      },
      byClient: byClient.map((r) => ({
        patientId: r.patient_id,
        patientName: r.patient_name,
        payerName: r.payer_name,
        bills: n(r.bills),
        billedCents: n(r.billed_cents),
        paidCents: n(r.paid_cents),
        deniedCount: n(r.denied_count),
        lastActivityAt: r.last_activity_at?.toISOString() ?? null,
      })),
      byNurse: byNurse.map((r) => ({
        clinicianUserId: r.clinician_user_id,
        clinicianName: r.clinician_name,
        bills: n(r.bills),
        submitted: n(r.submitted),
        paid: n(r.paid),
        denied: n(r.denied),
        billedCents: n(r.billed_cents),
      })),
    };
  });
}

export interface BillableVisit {
  visitId: string;
  visitType: string;
  status: string;
  dateOfService: string | null;
  clinicianName: string | null;
  /** Existing superbill for this visit, when one has already been created. */
  superbillId: string | null;
  superbillStatus: string | null;
  billedAmountCents: number | null;
}

/**
 * Visits for one patient that a bill can be raised against — powers the
 * "Create Bill" flow's appointment dropdown (walkthrough 04:03: "jaise hum
 * client select karein to us ki jitni bhi visits schedule hui, us ka
 * drop-down humare paas aa jaye"). Includes visits that already have a
 * superbill so the UI can say so instead of silently duplicating.
 */
export async function listBillableVisits(args: {
  orgId: string;
  patientId: string;
}): Promise<BillableVisit[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        visit_id: string;
        visit_type: string;
        status: string;
        dos: Date | null;
        clinician_name: string | null;
        superbill_id: string | null;
        superbill_status: string | null;
        billed_amount_cents: bigint | null;
      }[]
    >`
      SELECT v.id AS visit_id, v.visit_type, v.status,
             COALESCE(v.start_time, v.scheduled_start) AS dos,
             COALESCE(u.full_name, u.email) AS clinician_name,
             s.id AS superbill_id, s.status AS superbill_status,
             s.billed_amount_cents
      FROM visit v
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      LEFT JOIN superbill s ON s.visit_id = v.id
      WHERE v.patient_id = ${args.patientId}::uuid
      ORDER BY COALESCE(v.start_time, v.scheduled_start, v.created_at) DESC
      LIMIT 100
    `;
    return rows.map((r) => ({
      visitId: r.visit_id,
      visitType: r.visit_type,
      status: r.status,
      dateOfService: r.dos ? r.dos.toISOString() : null,
      clinicianName: r.clinician_name,
      superbillId: r.superbill_id,
      superbillStatus: r.superbill_status,
      billedAmountCents: r.billed_amount_cents !== null ? Number(r.billed_amount_cents) : null,
    }));
  });
}
