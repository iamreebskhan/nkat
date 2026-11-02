/**
 * PCM/CCM time (0117; Level-1 doc:53, :101).
 *
 *   GET  ?month=YYYY-MM — the month (left out, the practice's current one): the
 *        enrolments in force in it, their time, how far it has come under each
 *        code set, and its charge (patients.view)
 *   POST — log time on an enrolled patient's care (visits.create: clinical
 *        documentation, as a call is)
 */
import { type NextRequest } from "next/server";

import { fail, handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { LogTimeSchema, MonthQuerySchema } from "@/lib/features/care-coordination/care-management";
import { getMonth, logTime } from "@/lib/features/care-coordination/care-management.service";
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
  const q = MonthQuerySchema.safeParse({ month: req.nextUrl.searchParams.get("month") });
  if (!q.success) return fail("The month is month=YYYY-MM.", { status: 422 });
  try {
    const month = await getMonth({ orgId: session.orgId, patientId: id, month: q.data.month, viewerUserId: session.userId });
    void logPhiAccess({
      orgId: session.orgId, userId: session.userId, patientId: id, accessType: "view", context: "care_management_time", request: req,
    });
    return ok(month);
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["visits.create"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const body = await parseJson(req, LogTimeSchema);
  if (body instanceof Response) return body;
  try {
    return ok(await logTime({ orgId: session.orgId, userId: session.userId, patientId: id, payload: body }), { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
