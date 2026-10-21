/**
 * PATCH /api/visits/[id]/visit-type
 *
 * Correct a visit's type before it is signed. The type decides the CPT band
 * the visit is coded on — a first visit booked as established bills 99347-99350
 * instead of 99341-99345 — and until this route nothing could change it after
 * scheduling, so the only fix left was a code override on the bill after
 * signing. changeVisitType refuses a signed visit, a type that is not one of
 * this org's active types, and clears the codes saved under the old band.
 */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { changeVisitType } from "@/lib/features/visits/visit.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { ChangeVisitTypeSchema } from "@/lib/features/visits/visit.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  // visits.edit is NOT an ownership gate: the clinician template carries it
  // right next to visits.view.own (lib/features/team/team.types.ts), and
  // changeVisitType checks the visit's status, never its clinician. What this
  // handler changes is the band a colleague's visit bills on, and it clears
  // the codes they saved. See visit-access.ts.
  //
  // The id is resolved before the body is parsed so the refusal comes first: a
  // caller who may not touch this visit should not learn from a 422 which of
  // their fields the schema would have accepted.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  const body = await parseJson(req, ChangeVisitTypeSchema);
  if (body instanceof Response) return body;

  try {
    const r = await changeVisitType({
      orgId: session.orgId,
      id,
      visitType: body.visitType,
      actorUserId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
