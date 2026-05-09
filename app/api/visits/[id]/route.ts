/**
 * Single visit — GET.
 */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisit } from "@/lib/features/visits/visit.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth([]);
  if (session instanceof Response) return session;
  if (
    !session.permissions.includes("visits.view.all") &&
    !session.permissions.includes("visits.view.own")
  ) {
    return fail("Permission denied", { status: 403 });
  }
  const { id } = await ctx.params;
  const visit = await getVisit({ orgId: session.orgId, id });
  if (!visit) return fail("Visit not found.", { status: 404 });
  // .own permission requires the row's clinician_user_id to match.
  if (
    !session.permissions.includes("visits.view.all") &&
    visit.clinicianUserId !== session.userId
  ) {
    return fail("Permission denied", { status: 403 });
  }
  void logPhiAccess({
    orgId: session.orgId,
    userId: session.userId,
    patientId: visit.patientId,
    accessType: "view",
    context: "visit_record",
    request: req,
  });
  return ok(visit);
}
