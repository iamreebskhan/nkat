/**
 * GET /api/denials/[id]/prediction — Phase B.2 predicted-vs-actual.
 *
 * Returns what the pre-submission predictor said for the denied CPT on
 * this denial's superbill, alongside the actual outcome.
 */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getDenialPrediction } from "@/lib/features/denials/denial.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["billing.denials.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const result = await getDenialPrediction({ orgId: session.orgId, id });
  if (!result) return fail("Denial not found.", { status: 404 });
  return ok(result);
}
