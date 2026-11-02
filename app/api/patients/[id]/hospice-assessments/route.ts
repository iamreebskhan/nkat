/**
 * POST /api/patients/[id]/hospice-assessments — potential hospice
 * appropriateness (Level-1 doc:37, :91; Mark Q11c default: yes or no, the day,
 * the basis). A clinical judgement, so it takes the grant acuity takes.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { addHospiceAssessment } from "@/lib/features/clinical/clinical-course.service";
import { HospiceAssessmentSchema } from "@/lib/features/clinical/clinical-course.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patient.acuity.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, HospiceAssessmentSchema);
  if (body instanceof Response) return body;
  try {
    const r = await addHospiceAssessment({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
