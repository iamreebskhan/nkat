/**
 * GET /api/patients/[id]/clinical-lists — the chart's problem list,
 * medication list and allergies, with "no known allergies" when it was
 * recorded (0114; Level-1 doc:36). Every entry, active first: a resolved
 * problem or a stopped medication is history the chart keeps.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getClinicalLists } from "@/lib/features/clinical/clinical-lists.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const lists = await getClinicalLists({ orgId: session.orgId, patientId: id });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "clinical_lists",
      request: req,
    });
    return ok(lists);
  } catch (err) {
    return handleServiceError(err);
  }
}
