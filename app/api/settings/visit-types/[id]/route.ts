/**
 * PATCH /api/settings/visit-types/[id]
 *
 * Rename a type, change which CPT band it bills as, or deactivate it.
 *
 * No DELETE: past visits carry the slug, and dropping the row would leave
 * those encounters with an unresolvable type. Deactivating takes it out of the
 * scheduling dropdown while history stays readable.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  UpdateVisitTypeSchema,
  updateVisitType,
} from "@/lib/features/visits/visit-types.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;

  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;

  const body = await parseJson(req, UpdateVisitTypeSchema);
  if (body instanceof Response) return body;

  try {
    const r = await updateVisitType({
      orgId: session.orgId,
      id,
      payload: body,
      actorUserId: session.userId,
    });
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
