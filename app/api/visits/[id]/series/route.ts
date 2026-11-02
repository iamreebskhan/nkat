/**
 * POST /api/visits/[id]/series — this visit and the later ones of its series
 * (0126): cancel them, or move them. Gated as moving a visit is: schedule.edit
 * is not an ownership gate, so the visit-level check matters (see the reschedule
 * route).
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok, parseJson, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { pushVisitToGoogle } from "@/lib/features/calendar/google-calendar.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";
import { cancelSeriesFrom, moveSeriesFrom } from "@/lib/features/visits/visit-series.service";
import { SeriesActionSchema } from "@/lib/features/visits/visit.types";

interface Params {
  params: Promise<{ id: string }>;
}

const HOUR_MS = 60 * 60_000;

export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["schedule.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  const denied = await requireVisitAccess({ session, visitId: id, access: "schedule" });
  if (denied) return denied;
  const body = await parseJson(req, SeriesActionSchema);
  if (body instanceof Response) return body;
  // Cancelling asks what cancelling one visit asks (the transition route).
  if (body.action === "cancel") {
    const allowed = await requireAuth(["visits.submit"]);
    if (allowed instanceof Response) return allowed;
  }
  try {
    if (body.action === "cancel") return ok(await cancelSeriesFrom({ orgId: session.orgId, visitId: id, actorUserId: session.userId }));
    const r = await moveSeriesFrom({
      orgId: session.orgId,
      visitId: id,
      startLocal: body.startLocal,
      confirmDoubleBook: body.confirmDoubleBook,
      actorUserId: session.userId,
    });
    for (const m of r.moved) {
      void pushVisitToGoogle({
        orgId: session.orgId,
        userId: m.clinicianUserId,
        visitId: m.id,
        startIso: m.start,
        endIso: m.end ?? new Date(new Date(m.start).getTime() + HOUR_MS).toISOString(),
        summary: `Pallio visit (${m.visitType})`,
        description: `Patient ${m.patientId}`,
      }).catch(() => {
        /* not linked / config missing — swallow */
      });
    }
    return ok(r);
  } catch (err) {
    return handleServiceError(err);
  }
}
