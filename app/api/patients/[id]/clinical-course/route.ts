/**
 * GET /api/patients/[id]/clinical-course — the course of care (0115): acuity
 * and its history, hospice eligibility, significant events, discharges.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getClinicalCourse } from "@/lib/features/clinical/clinical-course.service";
import { logPhiAccess } from "@/lib/hipaa/phi-access-log";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    const course = await getClinicalCourse({ orgId: session.orgId, patientId: id });
    void logPhiAccess({
      orgId: session.orgId,
      userId: session.userId,
      patientId: id,
      accessType: "view",
      context: "clinical_course",
      request: req,
    });
    return ok(course);
  } catch (err) {
    return handleServiceError(err);
  }
}
