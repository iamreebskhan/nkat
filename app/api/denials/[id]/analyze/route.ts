/**
 * POST /api/denials/[id]/analyze
 *
 * Runs the AI denial analyst against the denial + the matching payer
 * rule. Persists the result onto the denial row so future loads don't
 * re-call Claude. Returns the freshly computed analysis.
 */
import { type NextRequest } from "next/server";

import { ok, fail, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { analyzeDenial } from "@/lib/ai/denial-analyst";
import {
  getDenial,
  recordAiAnalysis,
} from "@/lib/features/denials/denial.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Params): Promise<Response> {
  // The analyst is part of the denial workflow — same permission as
  // logging gates the AI call (billing agents can self-serve).
  const session = await requireAuth(["billing.denials.log"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const denial = await getDenial({ orgId: session.orgId, id });
  if (!denial) return fail("Denial not found.", { status: 404 });

  // Resolve state from the superbill → patient → payer/state chain in
  // a follow-up phase. For Phase 4 we'd need to fetch the payer's
  // state coverage; the analyst is robust to a missing state (returns
  // heuristic).
  const result = await analyzeDenial({
    cptCode: denial.cptCode,
    payerId: denial.payerId,
    state: null,
    carcCode: denial.carcCode,
    rarcCode: denial.rarcCode,
    denialReason: denial.denialReason,
    deniedAmountCents: denial.deniedAmountCents,
    icd10Codes: denial.icd10Codes,
    dateOfService: new Date(denial.deniedAt),
  });

  await recordAiAnalysis({
    orgId: session.orgId,
    id,
    aiAnalysisText: result.text,
    aiLikelyCause: result.likelyCause,
    aiRecommendation: result.recommendation,
    aiCitationDocName: result.citation?.documentName ?? null,
    aiCitationQuote: result.citation?.verbatimQuote ?? null,
    aiModelVersion: result.modelVersion,
  });

  return ok(result);
}
