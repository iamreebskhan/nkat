/**
 * The acuity the NP gives at this visit (Mark Q9 default: kept apart from the
 * triage's, with its history; 0115).
 *
 *   GET — the one given at this visit, or null
 *   PUT — give it. It becomes the patient's current acuity. One per visit: a
 *         change during the visit corrects it.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getVisitAcuity, setVisitAcuity } from "@/lib/features/clinical/clinical-course.service";
import { VisitAcuitySchema } from "@/lib/features/clinical/clinical-course.types";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const denied = await requireVisitAccess({ session, visitId: id, access: "read" });
  if (denied) return denied;
  try {
    return ok(await getVisitAcuity({ orgId: session.orgId, visitId: id }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patient.acuity.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  // Written into the visit: its owner, or whoever may document any visit.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;
  const body = await parseJson(req, VisitAcuitySchema);
  if (body instanceof Response) return body;
  try {
    await setVisitAcuity({ orgId: session.orgId, userId: session.userId, visitId: id, acuity: body.acuity });
    return ok({ acuity: body.acuity });
  } catch (err) {
    return handleServiceError(err);
  }
}
