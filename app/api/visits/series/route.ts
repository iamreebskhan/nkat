/**
 * POST /api/visits/series — book a repeating visit (0126). The answer is either
 * the visits booked, or the days that need a person's eye with nothing booked:
 * the form then leaves those days out, or confirms them.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { pushVisitToGoogle } from "@/lib/features/calendar/google-calendar.service";
import { scheduleVisitSeries } from "@/lib/features/visits/visit-series.service";
import { ScheduleSeriesSchema } from "@/lib/features/visits/visit.types";

const HOUR_MS = 60 * 60_000;

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["schedule.create"]);
  if (session instanceof Response) return session;
  const body = await parseJson(req, ScheduleSeriesSchema);
  if (body instanceof Response) return body;
  try {
    const r = await scheduleVisitSeries({ orgId: session.orgId, userId: session.userId, payload: body });
    // As one visit: the clinician's calendar follows, fire-and-forget, and a
    // failure never undoes the booking.
    for (const v of r.booked) {
      void pushVisitToGoogle({
        orgId: session.orgId,
        userId: body.clinicianUserId,
        visitId: v.id,
        startIso: v.start,
        endIso: new Date(new Date(v.start).getTime() + HOUR_MS).toISOString(),
        summary: `Pallio visit (${body.visitType})`,
        description: `Patient ${body.patientId}`,
      }).catch(() => {
        /* not linked / config missing — swallow */
      });
    }
    return ok(r, { status: r.booked.length > 0 ? 201 : 200 });
  } catch (err) {
    return handleServiceError(err);
  }
}
