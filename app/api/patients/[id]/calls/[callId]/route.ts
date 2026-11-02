/**
 * PATCH /api/patients/[id]/calls/[callId] — void a call recorded in error,
 * with the reason (visits.edit). Its open escalation alerts are withdrawn.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { VoidPhoneEncounterSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { voidPhoneEncounter } from "@/lib/features/care-coordination/phone-encounter.service";

interface Params {
  params: Promise<{ id: string; callId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.edit"]);
  if (session instanceof Response) return session;
  const { id, callId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(callId);
  if (bad) return bad;
  const body = await parseJson(req, VoidPhoneEncounterSchema);
  if (body instanceof Response) return body;
  try {
    return ok(
      await voidPhoneEncounter({
        orgId: session.orgId, userId: session.userId, patientId: id, encounterId: callId, reason: body.void.reason,
      }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
