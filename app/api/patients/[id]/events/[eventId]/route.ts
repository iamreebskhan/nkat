/**
 * PATCH /api/patients/[id]/events/[eventId] — correct an event (an
 * admission's discharge day, the facility, the details), or void it as
 * recorded in error ({ void: { reason } }): kept, struck through, not counted.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { updateEvent } from "@/lib/features/clinical/clinical-course.service";
import { UpdateEventSchema } from "@/lib/features/clinical/clinical-course.types";

interface Params {
  params: Promise<{ id: string; eventId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id, eventId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(eventId);
  if (bad) return bad;
  const body = await parseJson(req, UpdateEventSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await updateEvent({ orgId: session.orgId, userId: session.userId, patientId: id, eventId, payload: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
