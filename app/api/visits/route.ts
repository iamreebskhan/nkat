/**
 * Visits collection — GET (list, filterable) + POST (schedule).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail, parseJson, parseSearchParams, handleServiceError } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";
import {
  getBusyForClinician,
  pushVisitToGoogle,
} from "@/lib/features/calendar/google-calendar.service";
import { isOnClinicalCareTeam, SCHEDULE_ANY_VISIT } from "@/lib/features/visits/visit-access";
import {
  getDailyCapacityStatus,
  listVisits,
  scheduleVisit,
} from "@/lib/features/visits/visit.service";
import {
  ScheduleVisitSchema,
  VISIT_STATUSES,
  VISIT_WINDOW_LIMIT,
} from "@/lib/features/visits/visit.types";

const ListSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    clinicianUserId: z.string().uuid().optional(),
    status: z.enum(VISIT_STATUSES).optional(),
    // A window: the schedule board's week, the route sheet's day. Read whole, up
    // to VISIT_WINDOW_LIMIT; without one the list is the newest 200.
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(VISIT_WINDOW_LIMIT).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: "The window's end must be after its start.",
  });

/**
 * How many visits match the list's filters — the size of the whole list, not
 * of one page.
 *
 * `total` used to be visits.length, so the patient chart read "50 visits on
 * file" for a patient with 206 of them and the 156 oldest vanished without a
 * word. That is audit R34, declared fixed in components/ui/pager.tsx: it was
 * fixed for the two billing queues and missed here.
 *
 * The predicates are listVisits' own, character for character. A total counted
 * over a different row set is a fresh untruth in place of the old one.
 */
async function countVisits(args: {
  orgId: string;
  patientId?: string;
  status?: (typeof VISIT_STATUSES)[number];
  clinicianUserId?: string;
  from?: string;
  to?: string;
}): Promise<number> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM visit v
       WHERE
         v.org_id = ${args.orgId}::uuid
         AND (${args.patientId ?? null}::uuid IS NULL OR v.patient_id = ${args.patientId ?? null}::uuid)
         AND (${args.status ?? null}::text IS NULL OR v.status = ${args.status ?? null})
         AND (${args.clinicianUserId ?? null}::uuid IS NULL OR v.clinician_user_id = ${args.clinicianUserId ?? null}::uuid)
         AND (${args.from ?? null}::timestamptz IS NULL OR COALESCE(v.start_time, v.scheduled_start) >= ${args.from ?? null}::timestamptz)
         AND (${args.to ?? null}::timestamptz IS NULL OR COALESCE(v.start_time, v.scheduled_start) < ${args.to ?? null}::timestamptz)
    `;
    return Number(rows[0]?.n ?? 0);
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  // visits.view.all and visits.view.own are both acceptable here; the
  // service-layer filter via clinicianUserId restricts the row set when
  // the caller has only the .own permission. We accept either.
  const session = await requireAuth([]);
  if (session instanceof Response) return session;
  const canSeeAll = session.permissions.includes("visits.view.all");
  const canSeeOwn = session.permissions.includes("visits.view.own");
  // The practice's scheduler sees every clinician's BOOKED visits — the
  // schedule board — and no other list (visit-access.ts SCHEDULE_ANY_VISIT).
  const canSeeBoard = session.permissions.includes(SCHEDULE_ANY_VISIT);
  if (!canSeeAll && !canSeeOwn && !canSeeBoard) {
    return fail("Permission denied", { status: 403 });
  }

  const url = new URL(req.url);
  const params = parseSearchParams(url, ListSchema);
  if (params instanceof Response) return params;
  const seesBoard = !canSeeAll && canSeeBoard && params.status === "scheduled";

  // If only .own, force the filter to this user. The count has to be given the
  // same narrowed value, or a clinician would be told how many visits the whole
  // org has while being shown only their own. One patient's list is the
  // exception: a member in the patient's clinical care team reads all of the
  // patient's visits (visit-access.ts mayReadVisit, Level-1 doc:49).
  const readsWholePatient =
    !canSeeAll &&
    !!params.patientId &&
    (await isOnClinicalCareTeam({ orgId: session.orgId, patientId: params.patientId, userId: session.userId }));
  const clinicianUserId =
    canSeeAll || readsWholePatient || seesBoard ? params.clinicianUserId : session.userId;

  const listed = await listVisits({
    orgId: session.orgId,
    patientId: params.patientId,
    status: params.status,
    clinicianUserId,
    from: params.from,
    to: params.to,
    limit: params.limit,
  });
  // The board is who and when, not what was written: a booked visit's note is
  // normally empty, and any text in another clinician's stays theirs.
  const visits = seesBoard
    ? listed.map((v) => (v.clinicianUserId === session.userId ? v : { ...v, documentText: null }))
    : listed;
  // Sequential, not Promise.all: each of these opens its own withOrgContext
  // transaction to set the tenant GUC, and firing them together exhausted the
  // Prisma pool on the claims screen (P2028), which then rendered as an empty
  // queue.
  const total = await countVisits({
    orgId: session.orgId,
    patientId: params.patientId,
    status: params.status,
    clinicianUserId,
    from: params.from,
    to: params.to,
  });
  // One chart, opened by someone outside its care team, lists only their own
  // visits, and "on file" has to mean on file: the chart is told how many more
  // it holds, never which, so it cannot read "No visits yet" over a colleague's
  // five. Behind the chart's own gate, like the vitals trend and the visit-type
  // hint, which are drawn from every clinician's visits too.
  const withheld =
    params.patientId &&
    !canSeeAll &&
    !readsWholePatient &&
    !seesBoard &&
    session.permissions.includes("patients.view")
      ? (await countVisits({ orgId: session.orgId, patientId: params.patientId, status: params.status })) - total
      : 0;
  return ok({ rows: visits, total, withheld });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["schedule.create"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, ScheduleVisitSchema);
  if (body instanceof Response) return body;

  // Phase E — Google conflict check. Only blocks if the clinician has
  // Google linked AND there's an overlap AND the caller didn't pass
  // confirmDoubleBook=true. Best-effort: any Google failure (missing
  // env, expired token, etc.) is logged and we proceed normally.
  if (!body.confirmDoubleBook) {
    try {
      const startIso = new Date(body.scheduledStart).toISOString();
      const endIso = body.scheduledEnd
        ? new Date(body.scheduledEnd).toISOString()
        : new Date(new Date(body.scheduledStart).getTime() + 60 * 60_000).toISOString();
      const busy = await getBusyForClinician({
        orgId: session.orgId,
        userId: body.clinicianUserId,
        fromIso: startIso,
        toIso: endIso,
      });
      if (busy.length > 0) {
        return fail("Conflict with existing Google Calendar events.", {
          status: 409,
        });
      }
    } catch {
      /* Google not linked / not configured → continue without conflict check */
    }

    // Phase E.2 — capacity guard. Same confirmDoubleBook override clears it.
    try {
      const cap = await getDailyCapacityStatus({
        orgId: session.orgId,
        clinicianUserId: body.clinicianUserId,
        at: body.scheduledStart,
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

  try {
    const r = await scheduleVisit({ orgId: session.orgId, payload: body, actorUserId: session.userId });
    // Fire-and-forget push to Google so the nurse's external calendar
    // reflects the new visit. Failure here doesn't undo the Pallio row.
    const startIso = new Date(body.scheduledStart).toISOString();
    const endIso = body.scheduledEnd
      ? new Date(body.scheduledEnd).toISOString()
      : new Date(new Date(body.scheduledStart).getTime() + 60 * 60_000).toISOString();
    void pushVisitToGoogle({
      orgId: session.orgId,
      userId: body.clinicianUserId,
      visitId: r.id,
      startIso,
      endIso,
      summary: `Pallio visit (${body.visitType})`,
      description: `Patient ${body.patientId}`,
    }).catch(() => {
      /* not linked / config missing — swallow */
    });
    return ok(r, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
}
