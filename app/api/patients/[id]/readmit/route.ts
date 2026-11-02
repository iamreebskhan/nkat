/**
 * POST /api/patients/[id]/readmit — back under care after a discharge (or a
 * discharge recorded in error), with the day and why. The discharge is kept,
 * marked; the new episode's length of stay starts from the readmission.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { readmitPatient } from "@/lib/features/clinical/clinical-course.service";
import { ReadmitSchema } from "@/lib/features/clinical/clinical-course.types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, ReadmitSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await readmitPatient({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body }));
  } catch (err) {
    return handleServiceError(err);
  }
}
