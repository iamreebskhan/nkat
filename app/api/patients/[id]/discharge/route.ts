/**
 * The discharge workflow (Level-1 doc:93-95, :108; 0115).
 *
 *   POST  — discharge: the day, the practice's discharge code (0111), and for
 *           a move to hospice the hospice and its admission day. A death code
 *           makes the patient deceased.
 *   PATCH — the hospice stay as it becomes known: the hospice and its
 *           admission day, then how the stay ended, which gives the hospice
 *           length of stay (doc:95; Mark Q11j default: entered by hand).
 *
 * Readmission is POST /api/patients/[id]/readmit.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { dischargePatient, recordHospiceStay } from "@/lib/features/clinical/clinical-course.service";
import { DischargeSchema, HospiceStaySchema } from "@/lib/features/clinical/clinical-course.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, DischargeSchema);
  if (body instanceof Response) return body;
  try {
    const r = await dischargePatient({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, HospiceStaySchema);
  if (body instanceof Response) return body;
  try {
    return ok(await recordHospiceStay({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
