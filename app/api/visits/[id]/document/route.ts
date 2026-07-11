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
import { DocumentVisitSchema } from "@/lib/features/visits/visit.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, DocumentVisitSchema);
  if (body instanceof Response) return body;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
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
