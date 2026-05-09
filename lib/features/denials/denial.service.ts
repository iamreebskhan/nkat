/**
 * Denial workflow service — Prisma I/O against `superbill_denial`.
 *
 * Multi-tenant via `withOrgContext`. RLS policies on the table mean
 * even a forged orgId at this layer can't leak rows.
 */
import { withOrgContext } from "@/lib/db";
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
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function logDenial(args: {
  orgId: string;
  payload: LogDenialInput;
}): Promise<{ id: string }> {
  const { orgId, payload } = args;
  return withOrgContext(orgId, async (tx) => {
    // Resolve payer_id from the superbill row (frozen at denial time).
    const sb = await tx.$queryRaw<{ payer_id: string | null }[]>`
      SELECT payer_id FROM superbill WHERE id = ${payload.superbillId}::uuid
    `;
    const payerId = sb[0]?.payer_id ?? null;

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
    return { id: rows[0]!.id };
  });
}

export async function getDenial(args: {
  orgId: string;
  id: string;
}): Promise<DenialView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<DenialRow[]>`
      SELECT * FROM superbill_denial WHERE id = ${args.id}::uuid LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

export async function listDenials(args: {
  orgId: string;
  decision?: DenialDecision;
  superbillId?: string;
  payerId?: string;
  limit?: number;
}): Promise<DenialView[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<DenialRow[]>`
      SELECT * FROM superbill_denial
      WHERE
        (${args.decision ?? null}::text IS NULL OR decision = ${args.decision ?? null})
        AND (${args.superbillId ?? null}::uuid IS NULL OR superbill_id = ${args.superbillId ?? null}::uuid)
        AND (${args.payerId ?? null}::uuid IS NULL OR payer_id = ${args.payerId ?? null}::uuid)
      ORDER BY denied_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToView);
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
    await tx.$executeRaw`
      UPDATE superbill_denial SET
        ai_analysis_text     = ${args.aiAnalysisText},
        ai_likely_cause      = ${args.aiLikelyCause},
        ai_recommendation    = ${args.aiRecommendation},
        ai_citation_doc_name = ${args.aiCitationDocName},
        ai_citation_quote    = ${args.aiCitationQuote},
        ai_analyzed_at       = now(),
        ai_model_version     = ${args.aiModelVersion},
        updated_at           = now()
      WHERE id = ${args.id}::uuid
    `;
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
    await tx.$executeRaw`
      UPDATE superbill_denial SET
        decision = ${args.decision},
        decision_at = now(),
        decision_by_user_id = ${args.byUserId}::uuid,
        decision_notes = COALESCE(${args.notes ?? null}, decision_notes),
        updated_at = now()
      WHERE id = ${args.id}::uuid
    `;
    // Auto-cascade: a write_off decision sets outcome to written_off
    // immediately (no separate outcome record needed).
    if (args.decision === "write_off") {
      await tx.$executeRaw`
        UPDATE superbill_denial SET
          outcome = 'written_off',
          outcome_at = now(),
          outcome_notes = COALESCE(${args.notes ?? null}, outcome_notes)
        WHERE id = ${args.id}::uuid
      `;
    }
  });
}

export async function markRefiled(args: {
  orgId: string;
  id: string;
  refiledAt?: string;
  notes?: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE superbill_denial SET
        refiled_at = COALESCE(${args.refiledAt ?? null}::timestamptz, now()),
        decision_notes = COALESCE(${args.notes ?? null}, decision_notes),
        updated_at = now()
      WHERE id = ${args.id}::uuid AND decision = 'refile'
    `;
  });
}

export async function recordOutcome(args: {
  orgId: string;
  id: string;
  outcome: Exclude<DenialOutcome, "pending">;
  amountCents?: number;
  notes?: string;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    await tx.$executeRaw`
      UPDATE superbill_denial SET
        outcome = ${args.outcome},
        outcome_at = now(),
        outcome_amount_cents = ${args.amountCents ?? null},
        outcome_notes = COALESCE(${args.notes ?? null}, outcome_notes),
        updated_at = now()
      WHERE id = ${args.id}::uuid
    `;
  });
}
