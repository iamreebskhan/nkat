/**
 * GET /api/patients/[id]/follow-up — what the care plan asks to be monitored
 * between visits, each item's last contact and when it falls due, and the
 * plan's review (0116; Level-1 doc:50-51).
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getFollowUp } from "@/lib/features/care-coordination/caseload.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await getFollowUp({ orgId: session.orgId, patientId: id }));
  } catch (err) {
    return handleServiceError(err);
  }
}
