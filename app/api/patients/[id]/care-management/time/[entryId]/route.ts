/**
 * PATCH /api/patients/[id]/care-management/time/[entryId] — void PCM/CCM time
 * recorded in error, with the reason (visits.edit). Refused once its month is
 * charged (0117).
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { VoidTimeSchema } from "@/lib/features/care-coordination/care-management";
import { voidTime } from "@/lib/features/care-coordination/care-management.service";

interface Params {
  params: Promise<{ id: string; entryId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;
  const { id, entryId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(entryId);
  if (bad) return bad;
  const body = await parseJson(req, VoidTimeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(
      await voidTime({ orgId: session.orgId, userId: session.userId, patientId: id, entryId, reason: body.void.reason }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
