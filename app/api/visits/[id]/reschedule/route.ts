/** PATCH /api/visits/[id]/reschedule — drag-to-reschedule on the grid. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson, handleServiceError, requireUuidParam } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getBusyForClinician,
  pushVisitToGoogle,
} from "@/lib/features/calendar/google-calendar.service";
import {
  endAfterMove,
  getDailyCapacityStatus,
  getVisit,
  rescheduleVisit,
} from "@/lib/features/visits/visit.service";
import { requireVisitAccess } from "@/lib/features/visits/visit-access";

const Body = z.object({
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime().nullable().optional(),
  /**
   * The caller has seen the Google Calendar conflict or the day's capacity and
   * moves the visit anyway — the override booking a new visit takes.
   */
  confirmDoubleBook: z.boolean().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

/** A visit with no end blocks an hour, as when it is booked. */
const HOUR_MS = 60 * 60_000;

export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  const session = await requireAuth(["schedule.edit"]);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const bad = requireUuidParam(id);
  if (bad) return bad;
  // schedule.edit is not an ownership gate. The clinician template carries it
  // (lib/features/team/team.types.ts) "so they can move their own visits on the
  // week grid" — own being the word the permission cannot enforce by itself. So
  // requireAuth above admits exactly the caller this boundary constrains, and
  // rescheduleVisit matches on id, org and status (WHERE id = ... AND org_id =
  // ... AND status = 'scheduled'), never on clinician. Without this line a
  // clinician holding another clinician's scheduled visit id could drag that
  // visit to a different day, on a colleague's calendar, and the colleague's
  // next 9am would just have moved. See visit-access.ts.
  const denied = await requireVisitAccess({ session, visitId: id });
  if (denied) return denied;
  // Before parseJson deliberately: a refused caller learns nothing about the
  // body either, not even whether the timestamp they sent was well formed.
  const body = await parseJson(req, Body);
  if (body instanceof Response) return body;

  // The checks booking a visit makes (app/api/visits/route.ts), so a visit
  // cannot be dragged onto a day or a slot it could not have been booked into.
  // The same confirmDoubleBook override clears both. Best-effort, as there.
  if (!body.confirmDoubleBook) {
    const visit = await getVisit({ orgId: session.orgId, id }).catch(() => null);
    if (visit && visit.status === "scheduled") {
      const startMs = new Date(body.scheduledStart).getTime();
      const end =
        endAfterMove(
          { start: visit.scheduledStart, end: visit.scheduledEnd },
          body.scheduledStart,
          body.scheduledEnd,
        ) ?? new Date(startMs + HOUR_MS).toISOString();

      // Google Calendar conflicts. Skipped when the new slot overlaps where the
      // visit is now: its own event is still there, and freeBusy cannot tell
      // it apart from anyone else's, so it would read as its own conflict.
      const nowStartMs = visit.scheduledStart ? new Date(visit.scheduledStart).getTime() : null;
      const nowEndMs =
        nowStartMs === null
          ? null
          : visit.scheduledEnd
            ? new Date(visit.scheduledEnd).getTime()
            : nowStartMs + HOUR_MS;
      const overlapsItself =
        nowStartMs !== null && nowEndMs !== null && startMs < nowEndMs && new Date(end).getTime() > nowStartMs;
      if (!overlapsItself) {
        try {
          const busy = await getBusyForClinician({
            orgId: session.orgId,
            userId: visit.clinicianUserId,
            fromIso: new Date(startMs).toISOString(),
            toIso: end,
          });
          if (busy.length > 0) {
            return fail("Conflict with existing Google Calendar events.", { status: 409 });
          }
        } catch {
          /* Google not linked / not configured → continue without conflict check */
        }
      }

      // The day's capacity, the visit being moved not counted against it.
      try {
        const cap = await getDailyCapacityStatus({
          orgId: session.orgId,
          clinicianUserId: visit.clinicianUserId,
          at: body.scheduledStart,
          excludeVisitId: id,
        });
        if (cap.over) {
          return fail(
            `This clinician already has ${cap.count} visit(s) that day (cap ${cap.capacity}).`,
            { status: 409 },
          );
        }
      } catch {
        /* capacity check best-effort */
      }
    }
  }

  try {
    const r = await rescheduleVisit({
      orgId: session.orgId,
      id,
      scheduledStart: body.scheduledStart,
      // Left out when the body has none: the visit then keeps its length.
      // Turning a missing end into null here erased the end on every drag.
      scheduledEnd: body.scheduledEnd,
      // Who moved it, for the visit_reschedule audit row the service writes.
      actorUserId: session.userId,
    });
    if (!r.updated) return fail("Visit not found or not reschedulable.", { status: 404 });
    // Move the clinician's Google Calendar event with it, the way booking
    // creates it: fire-and-forget, and a failure never undoes the move.
    // pushVisitToGoogle updates the event it created; one never pushed (Google
    // linked after booking) is created now.
    if (r.moved) {
      const m = r.moved;
      void pushVisitToGoogle({
        orgId: session.orgId,
        userId: m.clinicianUserId,
        visitId: id,
        startIso: m.start,
        endIso: m.end ?? new Date(new Date(m.start).getTime() + HOUR_MS).toISOString(),
        summary: `Pallio visit (${m.visitType})`,
        description: `Patient ${m.patientId}`,
      }).catch(() => {
        /* not linked / config missing — swallow */
      });
    }
    return ok({ updated: true });
  } catch (err) {
    return handleServiceError(err);
  }
}
