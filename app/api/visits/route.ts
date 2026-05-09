/**
 * Visits collection — GET (list, filterable) + POST (schedule).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok, parseJson, parseSearchParams } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  listVisits,
  scheduleVisit,
} from "@/lib/features/visits/visit.service";
import {
  ScheduleVisitSchema,
  VISIT_STATUSES,
} from "@/lib/features/visits/visit.types";

const ListSchema = z.object({
  patientId: z.string().uuid().optional(),
  clinicianUserId: z.string().uuid().optional(),
  status: z.enum(VISIT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  // visits.view.all and visits.view.own are both acceptable here; the
  // service-layer filter via clinicianUserId restricts the row set when
  // the caller has only the .own permission. We accept either.
  const session = await requireAuth([]);
  if (session instanceof Response) return session;
  const canSeeAll = session.permissions.includes("visits.view.all");
  const canSeeOwn = session.permissions.includes("visits.view.own");
  if (!canSeeAll && !canSeeOwn) {
    return fail("Permission denied", { status: 403 });
  }

  const url = new URL(req.url);
  const params = parseSearchParams(url, ListSchema);
  if (params instanceof Response) return params;

  const visits = await listVisits({
    orgId: session.orgId,
    patientId: params.patientId,
    status: params.status,
    // If only .own, force the filter to this user.
    clinicianUserId: canSeeAll
      ? params.clinicianUserId
      : session.userId,
    limit: params.limit,
  });
  return ok({ rows: visits, total: visits.length });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["schedule.create"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, ScheduleVisitSchema);
  if (body instanceof Response) return body;

  try {
    const r = await scheduleVisit({ orgId: session.orgId, payload: body });
    return ok(r, { status: 201 });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Schedule failed", {
      status: 422,
    });
  }
}
