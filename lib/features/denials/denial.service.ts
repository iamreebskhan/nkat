/**
 * Denial workflow service — Prisma I/O against `superbill_denial`.
 *
 * Multi-tenant via `withOrgContext`. RLS policies on the table mean
 * even a forged orgId at this layer can't leak rows.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { dateColumnIso } from "@/lib/features/org/org-date";
import { markStatus } from "@/lib/features/superbills/superbill.service";

import { computeDenialMetrics, type DenialSummary } from "./denial-pure";
import type {
  AiRecommendation,
  DenialDecision,
  DenialOutcome,
  DenialView,
  LogDenialInput,
} from "./denial.types";

interface DenialRow {
  id: string;
  superbill_id: string;
  payer_id: string | null;
  cpt_code: string;
  icd10_codes: string[] | null;
  modifiers: string[] | null;
  carc_code: string;
  rarc_code: string | null;
  group_code: string | null;
  denial_reason: string | null;
  denied_amount_cents: bigint | number;
  denied_at: Date;
  ai_analysis_text: string | null;
  ai_likely_cause: string | null;
  ai_recommendation: AiRecommendation | null;
  ai_citation_doc_name: string | null;
  ai_citation_quote: string | null;
  ai_analyzed_at: Date | null;
  ai_model_version: string | null;
  decision: DenialDecision;
  decision_at: Date | null;
  decision_by_user_id: string | null;
  decision_notes: string | null;
  refiled_at: Date | null;
  outcome: DenialOutcome;
  outcome_at: Date | null;
  outcome_amount_cents: bigint | number | null;
  outcome_notes: string | null;
  /** Absent on reads before 0102, when every denial was recorded in Pallio. */
  source?: "recorded" | "remittance" | null;
  created_at: Date;
  updated_at: Date;
}

function rowToView(r: DenialRow): DenialView {
  return {
    id: r.id,
    superbillId: r.superbill_id,
    payerId: r.payer_id,
    cptCode: r.cpt_code,
    icd10Codes: r.icd10_codes ?? [],
    modifiers: r.modifiers ?? [],
    carcCode: r.carc_code,
    rarcCode: r.rarc_code,
    groupCode: r.group_code,
    denialReason: r.denial_reason,
    deniedAmountCents: Number(r.denied_amount_cents),
    deniedAt: r.denied_at.toISOString(),
    aiAnalysisText: r.ai_analysis_text,
    aiLikelyCause: r.ai_likely_cause,
    aiRecommendation: r.ai_recommendation,
    aiCitationDocName: r.ai_citation_doc_name,
    aiCitationQuote: r.ai_citation_quote,
    aiAnalyzedAt: r.ai_analyzed_at?.toISOString() ?? null,
    aiModelVersion: r.ai_model_version,
    decision: r.decision,
    decisionAt: r.decision_at?.toISOString() ?? null,
    decisionByUserId: r.decision_by_user_id,
    decisionNotes: r.decision_notes,
    refiledAt: r.refiled_at?.toISOString() ?? null,
    outcome: r.outcome,
    outcomeAt: r.outcome_at?.toISOString() ?? null,
    outcomeAmountCents:
      r.outcome_amount_cents !== null ? Number(r.outcome_amount_cents) : null,
    outcomeNotes: r.outcome_notes,
    source: r.source ?? "recorded",
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function logDenial(args: {
  orgId: string;
  payload: LogDenialInput;
  /** Recorded on the superbill's activity trail. */
  actorUserId?: string;
}): Promise<{ id: string }> {
  const { orgId, payload } = args;
  return withOrgContext(orgId, async (tx) => {
    // Resolve payer_id from the superbill row (frozen at denial time), and
    // refuse a bill that is not this org's. A miss used to carry on with no
    // payer: superbill_denial's foreign key is checked with row security off,
    // so even under RLS another org's bill id was accepted, and the denial,
    // its history row and (on a connection that bypasses RLS) the move to
    // denied all landed on a claim this org cannot open.
    const sb = await tx.$queryRaw<{ payer_id: string | null }[]>`
      SELECT payer_id FROM superbill
       WHERE id = ${payload.superbillId}::uuid AND org_id = ${orgId}::uuid
    `;
    if (!sb[0]) throw new NotFoundError("Superbill not found.");
    const payerId = sb[0].payer_id ?? null;

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO superbill_denial (
        org_id, superbill_id, payer_id, cpt_code,
        icd10_codes, modifiers,
        carc_code, rarc_code, group_code, denial_reason,
        denied_amount_cents, denied_at
      ) VALUES (
        ${orgId}::uuid, ${payload.superbillId}::uuid, ${payerId}::uuid,
        ${payload.cptCode},
        ${payload.icd10Codes ?? []}::text[],
        ${payload.modifiers ?? []}::text[],
        ${payload.carcCode}, ${payload.rarcCode ?? null}, ${payload.groupCode ?? null},
        ${payload.denialReason ?? null},
        ${payload.deniedAmountCents ?? 0},
        ${payload.deniedAt}::timestamptz
      )
      RETURNING id
    `;

    // Keep the superbill's own status machine in sync: a logged denial moves
    // a submitted/partially-paid superbill to 'denied'. Opportunistic — a
    // draft superbill (harness flows log denials pre-submission) is left
    // alone rather than forcing an illegal transition.
    const moved = await tx.$queryRaw<{ from_status: string; visit_id: string | null }[]>`
      WITH prev AS (
        SELECT id, status, visit_id FROM superbill
         WHERE id = ${payload.superbillId}::uuid
           AND org_id = ${orgId}::uuid
           AND status IN ('submitted', 'partially_paid')
         FOR UPDATE
      )
      UPDATE superbill s
         SET status = 'denied', updated_at = now()
        FROM prev
       WHERE s.id = prev.id
      RETURNING prev.status AS from_status, prev.visit_id
    `;
    // The claim's move to denied belongs in the audit trail too (audit R24).
    // markStatus writes one for the queue's Denied; without this, a denial
    // logged from the EOB left the visit's trail going straight from
    // "submitted" to a refile decision. Ids and statuses only: the CARC and
    // the reason stay on the claim history.
    if (moved[0]) {
      await writeAudit(tx, {
        orgId,
        userId: args.actorUserId ?? null,
        action: "superbill_status_change",
        targetType: "superbill",
        targetId: payload.superbillId,
        payload: {
          from: moved[0].from_status,
          to: "denied",
          visitId: moved[0].visit_id,
          denialId: rows[0]!.id,
        },
      });
    }

    // The denial is the pivot of the correction loop — put it on the bill's
    // trail so "this was rejected, and why" reads in one place.
    await tx.$executeRaw`
      INSERT INTO superbill_activity (
        org_id, superbill_id, actor_user_id, kind, to_status, summary, detail
      ) VALUES (
        ${orgId}::uuid, ${payload.superbillId}::uuid, ${args.actorUserId ?? null}::uuid,
        'denial_logged', 'denied',
        ${`Denied by payer — CARC ${payload.carcCode}${payload.denialReason ? `: ${payload.denialReason}` : ""}`},
        ${JSON.stringify({
          carcCode: payload.carcCode,
          rarcCode: payload.rarcCode ?? null,
          cptCode: payload.cptCode,
          deniedAmountCents: payload.deniedAmountCents ?? 0,
        })}::jsonb
      )
    `;

    return { id: rows[0]!.id };
  });
}

export async function getDenial(args: {
  orgId: string;
  id: string;
}): Promise<DenialView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<DenialRow[]>`
      SELECT * FROM superbill_denial
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

/**
 * What the denial analyst judges a denial against: the bill's date of service
 * and the state the patient's coverage is in (the insurance state, else the
 * address state, as the bill page's coverage rules read it).
 *
 * The analyze route passed the denial's own timestamp as the date of service
 * and no state at all, and the analyst answers from the CARC heuristic alone
 * when it has no state, so it never looked a payer rule up. Named by org, as
 * every read here should be on a connection that bypasses RLS.
 */
export async function getDenialRuleContext(args: {
  orgId: string;
  id: string;
}): Promise<{ dateOfService: string; state: string | null } | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ date_of_service: Date; state: string | null }[]>`
      SELECT s.date_of_service, COALESCE(p.insurance_state, p.state) AS state
        FROM superbill_denial d
        JOIN superbill s ON s.id = d.superbill_id AND s.org_id = d.org_id
        LEFT JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
       WHERE d.id = ${args.id}::uuid
         AND d.org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    const r = rows[0];
    // date_of_service is a DATE: its UTC day is the stored day.
    return r ? { dateOfService: dateColumnIso(r.date_of_service), state: r.state } : null;
  });
}

/**
 * Predicted-vs-actual for a denial (Phase B.2). Pulls the pre-submission
 * predictor output captured on the denied superbill and the line entry
 * matching this denial's CPT, so the UI can show "we predicted this" or
 * "we missed this". Returns null if no prediction was captured.
 */
export async function getDenialPrediction(args: {
  orgId: string;
  id: string;
}): Promise<{
  cptCode: string;
  outcome: DenialOutcome;
  predictedForCode: { riskBand: string; score: number } | null;
  worstBand: string | null;
} | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { cpt_code: string; outcome: DenialOutcome; predicted_risk: unknown }[]
    >`
      SELECT d.cpt_code, d.outcome, s.predicted_risk
        FROM superbill_denial d
        JOIN superbill s ON s.id = d.superbill_id AND s.org_id = d.org_id
       WHERE d.id = ${args.id}::uuid
         AND d.org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    const pr = r.predicted_risk as
      | { worstBand?: string; perLine?: Array<{ code: string; riskBand: string; score: number }> }
      | null;
    const line = pr?.perLine?.find((l) => l.code === r.cpt_code) ?? null;
    return {
      cptCode: r.cpt_code,
      outcome: r.outcome,
      predictedForCode: line ? { riskBand: line.riskBand, score: line.score } : null,
      worstBand: pr?.worstBand ?? null,
    };
  });
}

export async function listDenials(args: {
  orgId: string;
  decision?: DenialDecision;
  superbillId?: string;
  payerId?: string;
  limit?: number;
  /** Rows to skip — the denials screen pages through the whole list (R34). */
  offset?: number;
}): Promise<DenialView[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const rawOffset = args.offset ?? 0;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<DenialRow[]>`
      SELECT * FROM superbill_denial
      WHERE org_id = ${args.orgId}::uuid
        AND (${args.decision ?? null}::text IS NULL OR decision = ${args.decision ?? null})
        AND (${args.superbillId ?? null}::uuid IS NULL OR superbill_id = ${args.superbillId ?? null}::uuid)
        AND (${args.payerId ?? null}::uuid IS NULL OR payer_id = ${args.payerId ?? null}::uuid)
      ORDER BY denied_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(rowToView);
  });
}

/**
 * The denials screen's figures (count, dollars, pending decisions, top CARC,
 * by payer) over EVERY denial matching the filter.
 *
 * They were computed in the browser over the rows listDenials returned, which
 * is at most one page of 50, so past 50 the header and every KPI described an
 * arbitrary page (audit R34). This reads only the four columns the
 * aggregation needs, with no LIMIT (the same unbounded read the billing
 * overview's denial breakdown does), and reuses the tested pure aggregator.
 */
export async function summarizeDenials(args: {
  orgId: string;
  decision?: DenialDecision;
  superbillId?: string;
  payerId?: string;
}): Promise<DenialSummary> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        carc_code: string;
        payer_id: string | null;
        denied_amount_cents: bigint | number;
        decision: string;
      }[]
    >`
      SELECT carc_code, payer_id, denied_amount_cents, decision
        FROM superbill_denial
       WHERE org_id = ${args.orgId}::uuid
         AND (${args.decision ?? null}::text IS NULL OR decision = ${args.decision ?? null})
         AND (${args.superbillId ?? null}::uuid IS NULL OR superbill_id = ${args.superbillId ?? null}::uuid)
         AND (${args.payerId ?? null}::uuid IS NULL OR payer_id = ${args.payerId ?? null}::uuid)
    `;
    const metrics = computeDenialMetrics(
      rows.map((r) => ({
        carcCode: r.carc_code,
        payerId: r.payer_id,
        deniedAmountCents: Number(r.denied_amount_cents),
        decision: r.decision,
      })),
    );
    // Names for the by-payer rows and the payer filter, read from payer
    // itself so a withdrawn payer still reads by name: the screen used the
    // active-only payer list (audit R17). payer is the global catalog, with
    // no RLS, and a name is all this reads.
    const ids = [
      ...new Set(
        [...metrics.byPayerId.map((b) => b.payerId), args.payerId ?? null].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    const names =
      ids.length === 0
        ? []
        : await tx.$queryRaw<{ id: string; name: string }[]>`
            SELECT id, name::text AS name FROM payer WHERE id = ANY(${ids}::uuid[])
          `;
    return { ...metrics, payerNames: Object.fromEntries(names.map((n) => [n.id, n.name])) };
  });
}

export async function recordAiAnalysis(args: {
  orgId: string;
  id: string;
  aiAnalysisText: string;
  aiLikelyCause: string;
  aiRecommendation: AiRecommendation;
  aiCitationDocName: string | null;
  aiCitationQuote: string | null;
  aiModelVersion: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    const n = await tx.$executeRaw`
      UPDATE superbill_denial SET
        ai_analysis_text     = ${args.aiAnalysisText},
        ai_likely_cause      = ${args.aiLikelyCause},
        ai_recommendation    = ${args.aiRecommendation},
        ai_citation_doc_name = ${args.aiCitationDocName},
        ai_citation_quote    = ${args.aiCitationQuote},
        ai_analyzed_at       = now(),
        ai_model_version     = ${args.aiModelVersion},
        updated_at           = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    // Another org's denial, or none at all: a miss, never a success that
    // changed nothing.
    if (n === 0) throw new NotFoundError("Denial not found.");
  });
}

export async function decideDenial(args: {
  orgId: string;
  id: string;
  decision: Exclude<DenialDecision, "pending">;
  byUserId: string;
  notes?: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    const updated = await tx.$queryRaw<{ visit_id: string | null }[]>`
      UPDATE superbill_denial SET
        decision = ${args.decision},
        decision_at = now(),
        decision_by_user_id = ${args.byUserId}::uuid,
        decision_notes = COALESCE(${args.notes ?? null}, decision_notes),
        updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      RETURNING (SELECT s.visit_id FROM superbill s
                  WHERE s.id = superbill_denial.superbill_id AND s.org_id = superbill_denial.org_id) AS visit_id
    `;
    // Another org's denial, or none at all: the route answered 200 for a
    // decision that changed nothing.
    if (updated.length === 0) throw new NotFoundError("Denial not found.");
    // Auto-cascade: a write_off decision sets outcome to written_off
    // immediately (no separate outcome record needed).
    if (args.decision === "write_off") {
      await tx.$executeRaw`
        UPDATE superbill_denial SET
          outcome = 'written_off',
          outcome_at = now(),
          outcome_notes = COALESCE(${args.notes ?? null}, outcome_notes)
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
    }
    // In the audit log too (audit R24). The decision only: notes are free
    // text and stay on the denial.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.byUserId,
      action: "denial_decision",
      targetType: "denial",
      targetId: args.id,
      payload: { decision: args.decision, visitId: updated[0]!.visit_id },
    });
  });
}

/**
 * Record that a denied claim has been sent out again.
 *
 * Sends the CLAIM out too, not just the denial row.
 *
 * This used to stamp superbill_denial.refiled_at and stop. The superbill
 * stayed 'denied' and no superbill_activity row was written, so a refile done
 * through the denials workflow was invisible to everything downstream — while
 * the same refile done from the claims queue (which goes through markStatus)
 * was recorded properly. Two paths, two different answers.
 *
 * What that cost: markStatus is the only writer of the 'resubmitted' activity
 * kind, and 'resubmitted' is what the Adjustments card counts as a refile
 * [14:00 — "how many adjustments they've had to make"]. Refiling from the
 * screen built for refiling left that figure at zero.
 */
export async function markRefiled(args: {
  orgId: string;
  id: string;
  refiledAt?: string;
  notes?: string;
  actorUserId?: string;
  /** Refile over a payer documentation gap, with the reason (audit R19). */
  documentationOverride?: { reason: string };
}): Promise<void> {
  const superbillId = await withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ superbill_id: string }[]>`
      SELECT superbill_id FROM superbill_denial
       WHERE id = ${args.id}::uuid AND decision = 'refile'
         AND org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    return rows[0]?.superbill_id ?? null;
  });

  if (!superbillId) {
    throw new NotFoundError("No denial marked for refile with that id.");
  }

  // Send the claim FIRST, and stamp the refile only once it has gone. The
  // stamp used to come first, so a refusal (a blank rendering-provider NPI,
  // or since audit R19 a payer documentation gap) left a refile recorded on
  // a claim that never left.
  //
  // denied → submitted is already a legal move ("refiled claims go out
  // again"). Tolerate a claim that is not currently denied: the claims queue
  // may have sent it first, and then the refile record is still true.
  try {
    await markStatus({
      orgId: args.orgId,
      id: superbillId,
      to: "submitted",
      actorUserId: args.actorUserId,
      ...(args.documentationOverride ? { documentationOverride: args.documentationOverride } : {}),
    });
  } catch (err) {
    if (!(err instanceof ValidationError) || !/Illegal superbill transition/.test(err.message)) {
      throw err;
    }
    // An illegal move is that race only when the claim really did go back out
    // after this denial: the queue's Resubmitted writes a 'resubmitted' entry
    // on the claim's history (and the claim may have been paid since). Every
    // status with no path to 'submitted' (paid, voided, draft, partially paid)
    // raises the same message, and swallowing those stamped a refile on a
    // claim that never left.
    const resent = await withOrgContext(args.orgId, (tx) =>
      tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok
          FROM superbill_activity a
          JOIN superbill_denial d ON d.superbill_id = a.superbill_id AND d.org_id = a.org_id
         WHERE d.id = ${args.id}::uuid
           AND d.org_id = ${args.orgId}::uuid
           AND a.kind = 'resubmitted'
           AND a.at >= d.created_at
         LIMIT 1
      `,
    );
    if (resent.length === 0) {
      const status = /transition (\S+) →/.exec(err.message)?.[1]?.replace(/_/g, " ");
      throw new ValidationError(
        `This claim is ${status ?? "not denied"}, so it cannot be refiled from here. Check its status on the claims queue.`,
      );
    }
  }

  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE superbill_denial SET
        refiled_at = COALESCE(${args.refiledAt ?? null}::timestamptz, now()),
        decision_notes = COALESCE(${args.notes ?? null}, decision_notes),
        updated_at = now()
      WHERE id = ${args.id}::uuid AND decision = 'refile'
        AND org_id = ${args.orgId}::uuid
    `;
  });
}

/**
 * What finally happened to a denied claim, and how much of it came back.
 *
 * THE DENIAL IS THE BOUND ON THE AMOUNT. It was bounded by nothing: the route's
 * schema takes any non-negative integer, and nothing compared the figure to
 * what this denial actually denied. So the same cents/dollars slip markStatusTx
 * refuses on a claim — 9850 typed for $98.50 — recorded $98.50 recovered
 * against a $9.85 denial, and the denial screen printed it back as fact.
 *
 * Not a hard ceiling, for the reason the claim's is not: a payer really can pay
 * more than the line it denied (interest, or a reprocessed claim paying the
 * whole line), and a recovery that cannot be recorded is as wrong in the other
 * direction. Confirming it is what makes it recordable, and the audit row then
 * carries that it was confirmed against the denied amount.
 */
export async function recordOutcome(args: {
  orgId: string;
  id: string;
  outcome: Exclude<DenialOutcome, "pending">;
  amountCents?: number;
  notes?: string;
  /** Named in the audit log (audit R24). */
  byUserId?: string;
  /** Sent only once the caller has been shown both figures and confirmed. */
  overpaymentAcknowledged?: boolean;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    let overpayment: { deniedAmountCents: number } | null = null;
    if (args.amountCents !== undefined) {
      const rows = await tx.$queryRaw<{ denied_amount_cents: bigint | number }[]>`
        SELECT denied_amount_cents FROM superbill_denial
         WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
         FOR UPDATE
      `;
      if (!rows[0]) throw new NotFoundError("Denial not found.");
      const denied = Number(rows[0].denied_amount_cents ?? 0);
      // A denial recorded with no amount — the queue's one-click Record denial
      // leaves denied_amount_cents 0 — offers nothing to compare against, and
      // bounding by 0 would refuse every outcome recorded on one.
      if (denied > 0 && args.amountCents > denied) {
        const got = `$${(args.amountCents / 100).toFixed(2)}`;
        const was = `$${(denied / 100).toFixed(2)}`;
        if (!args.overpaymentAcknowledged) {
          throw new ValidationError(
            `That records ${got} recovered on a denial of ${was}. Amounts are recorded in dollars and cents, so $50.00 is 50.00, not 5000. If the payer really did pay more than it denied, confirm it as an overpayment.`,
          );
        }
        // More than the denial denied is not part of it. Recorded as partially
        // paid it read as a recovery still owed the rest, on a denial that had
        // been more than answered.
        if (args.outcome === "partially_paid") {
          throw new ValidationError(
            `${got} is more than the ${was} this denial denied, so it is not a partial recovery. Record it as paid, confirming the overpayment there.`,
          );
        }
        overpayment = { deniedAmountCents: denied };
      }
    }
    const updated = await tx.$queryRaw<{ visit_id: string | null }[]>`
      UPDATE superbill_denial SET
        outcome = ${args.outcome},
        outcome_at = now(),
        outcome_amount_cents = ${args.amountCents ?? null},
        outcome_notes = COALESCE(${args.notes ?? null}, outcome_notes),
        updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      RETURNING (SELECT s.visit_id FROM superbill s
                  WHERE s.id = superbill_denial.superbill_id AND s.org_id = superbill_denial.org_id) AS visit_id
    `;
    if (updated.length === 0) throw new NotFoundError("Denial not found.");
    // In the audit log too (audit R24): the outcome and amount, never notes.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.byUserId ?? null,
      action: "denial_outcome",
      targetType: "denial",
      targetId: args.id,
      payload: {
        outcome: args.outcome,
        visitId: updated[0]!.visit_id,
        ...(args.amountCents !== undefined ? { amountCents: args.amountCents } : {}),
        // So a figure above what was denied is never read back as ordinary.
        ...(overpayment ? { overpayment } : {}),
      },
    });
  });
}
