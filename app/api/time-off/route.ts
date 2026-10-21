/**
 * GET  /api/time-off?from&to  — PTO in range
 * POST /api/time-off          — add PTO
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { createTimeOff, listTimeOff } from "@/lib/features/schedule/time-off.service";

const Query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["schedule.view"]);
  if (session instanceof Response) return session;
  const params = parseSearchParams(new URL(req.url), Query);
  if (params instanceof Response) return params;
  const rows = await listTimeOff({ orgId: session.orgId, fromIso: params.from, toIso: params.to });
  return ok({ rows });
}

const Body = z.object({
  clinicianUserId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(200).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["schedule.create"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;
  try {
    // The caller's permissions travel with the booking: schedule.create lets a
    // clinician add PTO, but it says nothing about WHOSE calendar, and the Add
    // PTO composer offers every active member in a dropdown. createTimeOff is
    // what decides, so a second caller cannot reach the table without it.
    const r = await createTimeOff({
      orgId: session.orgId,
      createdBy: session.userId,
      createdByPermissions: session.permissions,
      clinicianUserId: body.clinicianUserId,
      startDate: body.startDate,
      endDate: body.endDate,
      reason: body.reason,
    });
    // 403 rather than the 422 the membership refusal uses: this one is about
    // who is asking, not about what they sent. handleServiceError has no 403
    // branch, which is why the service returns this instead of throwing.
    if (r.id === null) return fail(r.refusedReason, { status: 403 });
    return ok({ id: r.id }, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
