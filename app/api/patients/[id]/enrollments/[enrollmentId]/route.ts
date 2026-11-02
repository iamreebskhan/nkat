/**
 * PATCH /api/patients/[id]/enrollments/[enrollmentId] — end a PCM/CCM
 * enrolment, with the day and why (careplans.edit).
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { EndEnrollmentSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { endEnrollment } from "@/lib/features/care-coordination/enrollment.service";

interface Params {
  params: Promise<{ id: string; enrollmentId: string }>;
}

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.edit"]);
  if (session instanceof Response) return session;
  const { id, enrollmentId } = await ctx.params;
  const bad = requireUuidParam(id) ?? requireUuidParam(enrollmentId);
  if (bad) return bad;
  const body = await parseJson(req, EndEnrollmentSchema);
  if (body instanceof Response) return body;
  try {
    return ok(
      await endEnrollment({
        orgId: session.orgId, userId: session.userId, patientId: id, enrollmentId, endedOn: body.endedOn, reason: body.reason,
      }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
