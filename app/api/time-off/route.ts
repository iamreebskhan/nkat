/**
 * GET  /api/time-off?from&to  — PTO in range
 * POST /api/time-off          — add PTO
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseJson, parseSearchParams, handleServiceError } from "@/lib/api";
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
    const r = await createTimeOff({
      orgId: session.orgId,
      createdBy: session.userId,
      clinicianUserId: body.clinicianUserId,
      startDate: body.startDate,
      endDate: body.endDate,
      reason: body.reason,
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
