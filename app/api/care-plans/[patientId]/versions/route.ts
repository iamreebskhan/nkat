/**
 * GET /api/care-plans/[patientId]/versions — frozen care-plan snapshots.
 *
 * Snapshots are written when a visit-tied save signs the plan
 * (care_plan_version, append-only). This read side was never built —
 * the history existed in the DB with no way to see it. Answers "what
 * did the plan of care say when that visit was billed?"
 */
import { type NextRequest } from "next/server";

import { ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listCarePlanVersions } from "@/lib/features/care-plans/care-plan.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ patientId: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.view"]);
  if (session instanceof Response) return session;
  const { patientId } = await ctx.params;
  const bad = requireUuidParam(patientId);
  if (bad) return bad;
  const rows = await listCarePlanVersions({ orgId: session.orgId, patientId });
  void logPhiAccess({
    orgId: session.orgId,
    userId: session.userId,
    patientId,
    accessType: "view",
    context: "care_plan",
    request: req,
  });
  return ok({ rows, total: rows.length });
}
