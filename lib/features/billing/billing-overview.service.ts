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
import { dateColumnIso, orgLocalDate } from "@/lib/features/org/org-date";

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
  /**
   * The part of paidCents a payer's own 835 posted (audit R10). The rest is
   * what the team typed; the dashboard says which is which.
   */
  paidFromRemittanceCents: number;
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

/**
 * "Where those denials were" — the fourth part of the client's ask on
 * 20 Aug 2026 [14:07]: "how many denials they've had, where those denials
 * were, where they could manage their billing."
 *
 * Grouped two ways because "where" has two meanings a biller acts on
 * differently: which payer is rejecting, and what they are rejecting for.
 */
export interface DenialGroup {
  key: string;
  label: string;
  count: number;
  amountCents: number;
}

export interface DenialBreakdown {
  total: number;
  /** Denials recorded with no payer reason code yet — work to do, not zero. */
  withoutReason: number;
  /** Denials posted from a payer's 835, carrying its own CARC (audit R10). */
  fromRemittance: number;
  byPayer: DenialGroup[];
  byReason: DenialGroup[];
  byCode: DenialGroup[];
}

/**
 * "How many adjustments they've had to make" [14:00].
 *
 * Rework on claims, counted from the superbill activity trail: an `edited`
 * entry is a claim corrected after it was created, a `resubmitted` entry is a
 * denied claim sent out again. Deliberately NOT called a contractual
 * adjustment — this is operational rework, and conflating the two would
 * misreport money.
 */
export interface AdjustmentSummary {
  edits: number;
  refiles: number;
  total: number;
  /** Claims touched at least once, so one claim edited twice counts once. */
  claimsAffected: number;
}

export interface BillingOverview {
  totals: BillingTotals;
  byClient: BillingByClient[];
  byNurse: BillingByNurse[];
  denials: DenialBreakdown;
  adjustments: AdjustmentSummary;
  /**
   * True when a list here was cut short by the row cap, so the UI can say so
   * instead of presenting a page as the whole book.
   */
  truncated: { byClient: boolean; byNurse: boolean };
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
        paid_remittance_cents: bigint | null;
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
        -- Money excludes drafts and voided bills: a draft was never raised and
        -- a voided bill was cancelled, so neither is a charge. The status
        -- COUNTs above still report them, which is what the pipeline chips
        -- want; the totals must not.
        COALESCE(SUM(billed_amount_cents)
                 FILTER (WHERE status NOT IN ('draft', 'voided')), 0) AS billed_cents,
        COALESCE(SUM(paid_amount_cents)
                 FILTER (WHERE status NOT IN ('draft', 'voided')), 0) AS paid_cents,
        -- The part of that a payer's own 835 posted (audit R10), so the
        -- dashboard can say how much of "Collected" the payer confirmed.
        COALESCE(SUM(paid_amount_cents)
                 FILTER (WHERE status NOT IN ('draft', 'voided')
                           AND paid_source = 'remittance'), 0) AS paid_remittance_cents,
        COALESCE(SUM(billed_amount_cents - COALESCE(paid_amount_cents, 0))
                 FILTER (WHERE status IN ('submitted', 'partially_paid')), 0) AS outstanding_cents
      FROM superbill
      -- Every figure on this dashboard names the org as well as relying on
      -- RLS: on a connection that bypasses RLS these sums were every org's.
      WHERE org_id = ${args.orgId}::uuid
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
             COALESCE(SUM(s.billed_amount_cents)
                      FILTER (WHERE s.status NOT IN ('draft', 'voided')), 0) AS billed_cents,
             COALESCE(SUM(s.paid_amount_cents)
                      FILTER (WHERE s.status NOT IN ('draft', 'voided')), 0) AS paid_cents,
             COUNT(*) FILTER (WHERE s.status = 'denied') AS denied_count,
             MAX(s.updated_at)                         AS last_activity_at
      FROM superbill s
      JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
      LEFT JOIN payer pay ON pay.id = s.payer_id
      WHERE s.org_id = ${args.orgId}::uuid
      GROUP BY s.patient_id, p.first_name, p.last_name, pay.name
      ORDER BY MAX(s.updated_at) DESC NULLS LAST
      -- One more row than the page shows, so "is there more?" is answered by
      -- the data instead of inferred from a full page. A list of exactly the
      -- page size — the whole picture, nothing hidden — used to raise
      -- "Showing the busiest only — there are more." The extra row is trimmed
      -- off below, so everything downstream sees at most the page size.
      LIMIT ${limit + 1}
    `;
    const byClientTruncated = byClient.length > limit;
    if (byClientTruncated) byClient.length = limit;

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
             COALESCE(SUM(s.billed_amount_cents)
                      FILTER (WHERE s.status NOT IN ('draft', 'voided')), 0) AS billed_cents
      FROM superbill s
      JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      WHERE s.org_id = ${args.orgId}::uuid
      GROUP BY v.clinician_user_id, u.full_name, u.email
      ORDER BY COUNT(*) DESC
      -- The extra row, as above.
      LIMIT ${limit + 1}
    `;
    const byNurseTruncated = byNurse.length > limit;
    if (byNurseTruncated) byNurse.length = limit;

    const n = (v: bigint | null) => Number(v ?? 0);

    // ---- "how many denials they've had, WHERE those denials were" ----------
    // Read from superbill_denial rather than superbill.status: the status tells
    // you a claim was denied, this tells you by whom and for what, which is the
    // half the client actually acts on.
    const denialRows = await tx.$queryRaw<
      {
        payer_id: string | null;
        payer_name: string | null;
        carc_code: string;
        denial_reason: string | null;
        cpt_code: string;
        amount: bigint | null;
        /** 'remittance' when posted from a payer's 835 (audit R10). */
        source: string | null;
      }[]
    >`
      SELECT d.payer_id, py.name AS payer_name, d.carc_code, d.denial_reason,
             d.cpt_code, d.denied_amount_cents AS amount, d.source
        FROM superbill_denial d
        LEFT JOIN payer py ON py.id = d.payer_id
       WHERE d.org_id = ${args.orgId}::uuid
         AND d.outcome <> 'written_off'
    `;

    const group = (
      keyOf: (r: (typeof denialRows)[number]) => { key: string; label: string },
    ): DenialGroup[] => {
      const m = new Map<string, DenialGroup>();
      for (const r of denialRows) {
        const { key, label } = keyOf(r);
        const g = m.get(key) ?? { key, label, count: 0, amountCents: 0 };
        g.count += 1;
        g.amountCents += Number(r.amount ?? 0);
        m.set(key, g);
      }
      return [...m.values()].sort((a, b) => b.count - a.count);
    };

    const denials: DenialBreakdown = {
      total: denialRows.length,
      withoutReason: denialRows.filter((r) => r.carc_code === "UNCODED").length,
      fromRemittance: denialRows.filter((r) => r.source === "remittance").length,
      byPayer: group((r) => ({
        key: r.payer_id ?? "unknown",
        label: r.payer_name ?? "Payer not recorded",
      })),
      byReason: group((r) => ({
        key: r.carc_code,
        label:
          r.carc_code === "UNCODED"
            ? "Reason not recorded yet"
            : r.denial_reason
              ? `${r.carc_code} — ${r.denial_reason}`
              : r.carc_code,
      })),
      byCode: group((r) => ({ key: r.cpt_code, label: r.cpt_code })),
    };

    // ---- "how many adjustments they've had to make" ------------------------
    // from_status <> 'draft' is what makes this a count of ADJUSTMENTS rather
    // than a count of keystrokes.
    //
    // The superbill editor autosaves every 5 seconds while a nurse is still
    // assembling the draft, and each autosave writes an 'edited' activity row.
    // Counting those put roughly one "adjustment" per 5 seconds of authoring
    // into the figure Mark asked for at [14:00] — "how many adjustments
    // they've had to make". Building a claim is not adjusting it; the work he
    // means starts once the claim has left draft.
    //
    // The activity rows are still written, because the authoring trail is
    // worth keeping for audit. They are just not this number.
    const adjRows = await tx.$queryRaw<
      { kind: string; c: bigint; claims: bigint }[]
    >`
      SELECT kind, COUNT(*) AS c, COUNT(DISTINCT superbill_id) AS claims
        FROM superbill_activity
       WHERE org_id = ${args.orgId}::uuid
         AND kind IN ('edited', 'resubmitted')
         AND from_status IS DISTINCT FROM 'draft'
       GROUP BY kind
    `;
    const affected = await tx.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(DISTINCT superbill_id) AS c FROM superbill_activity
       WHERE org_id = ${args.orgId}::uuid
         AND kind IN ('edited', 'resubmitted')
         AND from_status IS DISTINCT FROM 'draft'
    `;
    const edits = n(adjRows.find((r) => r.kind === "edited")?.c ?? null);
    const refiles = n(adjRows.find((r) => r.kind === "resubmitted")?.c ?? null);

    return {
      denials,
      adjustments: {
        edits,
        refiles,
        total: edits + refiles,
        claimsAffected: n(affected[0]?.c ?? null),
      },
      // Each list asked for one row more than it shows: if that row came back
      // there really is more, and if it did not the list is complete. Saying
      // so is the difference between a page and a number the client believes
      // is the whole picture — and saying it when it is false teaches them to
      // ignore it.
      truncated: {
        byClient: byClientTruncated,
        byNurse: byNurseTruncated,
      },
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
        paidFromRemittanceCents: n(t.paid_remittance_cents),
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
  /**
   * 'YYYY-MM-DD': the bill's date of service once billed, else the day the
   * visit started where the practice is (0107).
   */
  dateOfService: string | null;
  clinicianName: string | null;
  /** Existing superbill for this visit, when one has already been created. */
  superbillId: string | null;
  superbillStatus: string | null;
  billedAmountCents: number | null;
}

export interface BillableClient {
  patientId: string;
  name: string;
  /** Disambiguates same-named patients in the picker. */
  dob: string | null;
  status: string;
  payerName: string | null;
  billableVisits: number;
  unbilledVisits: number;
}

/**
 * Clients who actually have a visit worth billing — powers the Create Bill
 * client dropdown (walkthrough 03:48: "is mein humare paas client selection
 * add hoga").
 *
 * Deliberately NOT the plain patient list. That list defaults to status
 * 'active', which silently hid discharged and deceased patients — in
 * palliative care those are the normal end states, and their claims are still
 * filed well after discharge or death. Keying off billable visits instead of
 * patient status includes them, and drops active patients with nothing to bill.
 */
export async function listBillableClients(args: {
  orgId: string;
}): Promise<BillableClient[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        patient_id: string;
        name: string;
        dob: Date | null;
        status: string;
        payer_name: string | null;
        billable_visits: bigint;
        unbilled_visits: bigint;
      }[]
    >`
      SELECT p.id AS patient_id,
             TRIM(p.first_name || ' ' || p.last_name) AS name,
             p.date_of_birth AS dob,
             p.status,
             pay.name AS payer_name,
             COUNT(v.id)                                     AS billable_visits,
             COUNT(v.id) FILTER (WHERE s.id IS NULL)         AS unbilled_visits
      FROM patient p
      -- This org's patients, their visits and bills, named as well as left
      -- to RLS; the visit's patient FK and the bill's visit FK are id-only.
      JOIN visit v ON v.patient_id = p.id AND v.org_id = p.org_id
        AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
      LEFT JOIN superbill s ON s.visit_id = v.id AND s.org_id = v.org_id
      LEFT JOIN payer pay ON pay.id = p.primary_payer_id
      -- Same rule as listBillableVisits: a "Not billed" visit type has nothing
      -- to bill (audit R18), unless it was billed before being re-banded.
      WHERE p.org_id = ${args.orgId}::uuid
        AND (s.id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM org_visit_type ot
               WHERE ot.org_id = v.org_id AND ot.slug = v.visit_type
                 AND ot.coding_basis = 'non_billable'))
      GROUP BY p.id, p.first_name, p.last_name, p.date_of_birth, p.status, pay.name
      ORDER BY COUNT(v.id) FILTER (WHERE s.id IS NULL) DESC, name ASC
      LIMIT 500
    `;
    return rows.map((r) => ({
      patientId: r.patient_id,
      name: r.name,
      dob: r.dob ? r.dob.toISOString().slice(0, 10) : null,
      status: r.status,
      payerName: r.payer_name,
      billableVisits: Number(r.billable_visits),
      unbilledVisits: Number(r.unbilled_visits),
    }));
  });
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
        superbill_dos: Date | null;
        org_timezone: string;
      }[]
    >`
      SELECT v.id AS visit_id, v.visit_type, v.status,
             COALESCE(v.start_time, v.scheduled_start) AS dos,
             COALESCE(u.full_name, u.email) AS clinician_name,
             s.id AS superbill_id, s.status AS superbill_status,
             s.billed_amount_cents,
             s.date_of_service AS superbill_dos,
             o.timezone AS org_timezone
      FROM visit v
      JOIN org o ON o.id = v.org_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      LEFT JOIN superbill s ON s.visit_id = v.id AND s.org_id = v.org_id
      WHERE v.org_id = ${args.orgId}::uuid
        AND v.patient_id = ${args.patientId}::uuid
        -- Only encounters that actually happened. 'cancelled' and 'no_show'
        -- were never delivered, and 'scheduled' hasn't happened yet — billing
        -- any of them is a false claim, and the draft would come out at $0
        -- because there are no coded charges.
        AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
        -- A "Not billed" visit type has nothing to bill (audit R18), and the
        -- server refuses to draft one. A visit billed before its type was
        -- re-banded still shows, so its bill can be opened.
        AND (s.id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM org_visit_type ot
               WHERE ot.org_id = v.org_id AND ot.slug = v.visit_type
                 AND ot.coding_basis = 'non_billable'))
      ORDER BY COALESCE(v.start_time, v.scheduled_start, v.created_at) DESC
      LIMIT 100
    `;
    return rows.map((r) => ({
      visitId: r.visit_id,
      visitType: r.visit_type,
      status: r.status,
      // The bill's DATE as stored once billed, which is what the claim says;
      // before that the visit's start, an instant, on the practice's day.
      dateOfService: r.superbill_dos
        ? dateColumnIso(r.superbill_dos)
        : r.dos
          ? orgLocalDate(r.dos, r.org_timezone)
          : null,
      clinicianName: r.clinician_name,
      superbillId: r.superbill_id,
      superbillStatus: r.superbill_status,
      billedAmountCents: r.billed_amount_cents !== null ? Number(r.billed_amount_cents) : null,
    }));
  });
}
