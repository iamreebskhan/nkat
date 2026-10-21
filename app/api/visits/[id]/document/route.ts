/**
 * PATCH /api/visits/[id]/document
 *
 * Save the clinician's documentation. Doesn't change status (use the
 * `transition` endpoint for that). Saving an in-progress visit leaves
 * the status `in_progress`; saving a `scheduled` visit auto-bumps to
 * `in_progress` per the service.
 */
import { type NextRequest } from "next/server";

import { ok, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { documentVisit } from "@/lib/features/visits/visit.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { DocumentVisitSchema } from "@/lib/features/visits/visit.types";

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
  // right next to visits.view.own (lib/features/team/team.types.ts), so
  // requireAuth above admits the caller this boundary exists to constrain, and
  // documentVisit checks the visit's status, never its clinician. What this
  // handler writes is what the visit BILLS — CPT codes, modifiers, ICD-10
  // codes, times, the telehealth flags and the note's free text — so a
  // clinician refused the READ of a colleague's visit could otherwise rewrite
  // the claim the colleague then signs under their own name. See
  // visit-access.ts.
  //
  // The id is resolved before the body is parsed so the refusal comes first: a
  // caller who may not touch this visit should not learn from a 422 which of
  // their fields the schema would have accepted.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;

  const body = await parseJson(req, DocumentVisitSchema);
  if (body instanceof Response) return body;

  try {
    const r = await documentVisit({
      orgId: session.orgId,
      id,
      payload: body,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
