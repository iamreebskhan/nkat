/**
 * POST /api/patients/[id]/events — a fall, an ED visit, a hospital admission
 * or another significant event (Level-1 doc:58, :86-89). Whoever edits the
 * chart records them: the nurse who hears of the fall on a call.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { addEvent } from "@/lib/features/clinical/clinical-course.service";
import { AddEventSchema } from "@/lib/features/clinical/clinical-course.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, AddEventSchema);
  if (body instanceof Response) return body;
  try {
    const r = await addEvent({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
