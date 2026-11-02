/**
 * PCM/CCM enrolment (0116; Level-1 doc:38, :101).
 *
 *   GET  — the patient's enrolments, the ones in force first (patients.view)
 *   POST — enrol, with the consent (careplans.edit)
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { EnrollSchema } from "@/lib/features/care-coordination/care-coordination.types";
import { enroll, listEnrollments } from "@/lib/features/care-coordination/enrollment.service";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  try {
    return ok(await listEnrollments({ orgId: session.orgId, patientId: id }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["careplans.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, EnrollSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await enroll({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body }), { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
