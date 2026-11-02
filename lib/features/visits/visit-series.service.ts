/**
 * Repeating visits (0126). Booking a series writes one ordinary visit per
 * occurrence in one transaction, or none: days that need a person's eye come
 * back unbooked, to skip or to confirm. Afterwards an occurrence is an ordinary
 * visit; "this and later" goes through the same cancel and move that one visit
 * goes through, so each writes its own audit row and keeps its own rules.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { addDaysIso, orgInstant, orgLocalDate, orgLocalInput } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import { seriesConflicts, seriesDays, seriesProblem, type SeriesConflict } from "./visit-series";
import { assertBookable, rescheduleVisit, transitionVisit } from "./visit.service";
import { CARE_MANAGEMENT_VISIT_TYPE, type ScheduleSeries } from "./visit.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

/** The clinician's visits by the practice's day, across the days asked about. */
async function visitsByDay(tx: Tx, a: { orgId: string; clinicianUserId: string; tz: string; days: string[]; notVisitIds?: string[] }) {
  const rows = await tx.$queryRaw<{ day: string; n: bigint | number }[]>`
    SELECT to_char((COALESCE(scheduled_start, start_time) AT TIME ZONE ${a.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n
      FROM visit
     WHERE org_id = ${a.orgId}::uuid
       AND clinician_user_id = ${a.clinicianUserId}::uuid
       AND status NOT IN ('cancelled', 'no_show')
       AND visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
       AND (COALESCE(scheduled_start, start_time) AT TIME ZONE ${a.tz})::date = ANY(${a.days}::date[])
       AND NOT (id = ANY(${a.notVisitIds ?? []}::uuid[]))
     GROUP BY 1
  `;
  return new Map(rows.map((r) => [r.day, Number(r.n)]));
}

async function readCapacity(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ daily_visit_capacity: number | null }[]>`
    SELECT daily_visit_capacity FROM org WHERE id = ${orgId}::uuid LIMIT 1
  `;
  return rows[0]?.daily_visit_capacity ?? 8;
}

async function readTimeOff(tx: Tx, a: { orgId: string; clinicianUserId: string; from: string; to: string }) {
  return tx.$queryRaw<{ startDate: string; endDate: string }[]>`
    SELECT to_char(start_date, 'YYYY-MM-DD') AS "startDate", to_char(end_date, 'YYYY-MM-DD') AS "endDate"
      FROM time_off
     WHERE org_id = ${a.orgId}::uuid
       AND clinician_user_id = ${a.clinicianUserId}::uuid
       AND start_date <= ${a.to}::date
       AND end_date >= ${a.from}::date
  `;
}

export interface BookedVisit {
  id: string;
  start: string;
}

export type SeriesResult = { booked: BookedVisit[]; conflicts: [] } | { booked: []; conflicts: SeriesConflict[] };

export async function scheduleVisitSeries(args: { orgId: string; userId: string; payload: ScheduleSeries }): Promise<SeriesResult> {
  const { orgId, payload } = args;
  return withOrgContext(orgId, async (tx) => {
    const tz = await readOrgTimeZone(tx, orgId);
    const { isTelehealth, modality } = await assertBookable(tx, orgId, payload);
    const [first, time] = payload.startLocal.split("T") as [string, string];
    const all = seriesDays({ first, every: payload.every, unit: payload.unit, until: payload.until, count: payload.count });
    const problem = seriesProblem(all);
    if (problem) throw new ValidationError(problem);
    const days = all.filter((d) => !payload.skipDays?.includes(d));
    if (days.length === 0) throw new ValidationError("Every day of the series was left out.");

    if (!payload.confirmDoubleBook) {
      const conflicts = seriesConflicts({
        days,
        visitsByDay: await visitsByDay(tx, { orgId, clinicianUserId: payload.clinicianUserId, tz, days }),
        capacity: await readCapacity(tx, orgId),
        timeOff: await readTimeOff(tx, { orgId, clinicianUserId: payload.clinicianUserId, from: days[0]!, to: days.at(-1)! }),
      });
      if (conflicts.length > 0) return { booked: [], conflicts };
    }

    const series = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO visit_series (org_id, patient_id, clinician_user_id, visit_type, every_n, unit, starts_on, until_on, visit_count, created_by_user_id)
      VALUES (${orgId}::uuid, ${payload.patientId}::uuid, ${payload.clinicianUserId}::uuid, ${payload.visitType},
              ${payload.every}::int, ${payload.unit}, ${first}::date, ${payload.until ?? null}::date, ${payload.count ?? null}::int, ${args.userId}::uuid)
      RETURNING id
    `;
    const seriesId = series[0]!.id;
    const starts = days.map((d) => orgInstant(`${d}T${time}`, tz).toISOString());
    const rows = await tx.$queryRaw<{ id: string; start: string }[]>`
      INSERT INTO visit (org_id, patient_id, clinician_user_id, visit_type, scheduled_start, is_telehealth, telehealth_modality, status, series_id)
      SELECT ${orgId}::uuid, ${payload.patientId}::uuid, ${payload.clinicianUserId}::uuid, ${payload.visitType},
             t.start::timestamptz, ${isTelehealth}, ${modality}, 'scheduled', ${seriesId}::uuid
        FROM unnest(${starts}::text[]) AS t(start)
      RETURNING id, to_char(scheduled_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start
    `;
    await writeAudit(tx, {
      orgId, userId: args.userId, action: "visit_series_create", targetType: "patient", targetId: payload.patientId,
      payload: { seriesId, visits: rows.length, every: payload.every, unit: payload.unit },
    });
    return { booked: rows, conflicts: [] };
  });
}

interface Occurrence {
  id: string;
  clinician_user_id: string;
  scheduled_start: Date;
}

/** This visit and the series' later ones still booked, earliest first. */
async function restOfSeries(tx: Tx, orgId: string, visitId: string): Promise<Occurrence[]> {
  const me = await tx.$queryRaw<{ series_id: string | null; scheduled_start: Date | null; status: string }[]>`
    SELECT series_id, scheduled_start, status FROM visit
     WHERE id = ${visitId}::uuid AND org_id = ${orgId}::uuid
     LIMIT 1
  `;
  const v = me[0];
  if (!v) throw new NotFoundError("Visit not found.");
  if (!v.series_id) throw new ValidationError("This visit is not part of a repeating series.");
  if (v.status !== "scheduled" || !v.scheduled_start) throw new ValidationError("Only a visit still booked can change the ones after it.");
  return tx.$queryRaw<Occurrence[]>`
    SELECT id, clinician_user_id, scheduled_start FROM visit
     WHERE org_id = ${orgId}::uuid
       AND series_id = ${v.series_id}::uuid
       AND status = 'scheduled'
       AND scheduled_start >= ${v.scheduled_start.toISOString()}::timestamptz
     ORDER BY scheduled_start
  `;
}

/** Cancel this visit and the later ones, each as a cancel of one visit is. */
export async function cancelSeriesFrom(args: { orgId: string; visitId: string; actorUserId: string }): Promise<{ cancelled: number }> {
  const rest = await withOrgContext(args.orgId, (tx) => restOfSeries(tx, args.orgId, args.visitId));
  for (const v of rest) await transitionVisit({ orgId: args.orgId, id: v.id, to: "cancelled", signedByUserId: args.actorUserId });
  return { cancelled: rest.length };
}

export type SeriesMoveResult = { moved: { id: string; clinicianUserId: string; start: string; end: string | null; patientId: string; visitType: string }[]; conflicts: [] } | { moved: []; conflicts: SeriesConflict[] };

/**
 * Move this visit and the later ones: each by the same number of days, all to
 * the new time on the practice's clock. Days they would land on are checked as a
 * booking is; the visits being moved are not counted against those days.
 */
export async function moveSeriesFrom(args: {
  orgId: string;
  visitId: string;
  startLocal: string;
  confirmDoubleBook?: boolean;
  actorUserId: string;
}): Promise<SeriesMoveResult> {
  const plan = await withOrgContext(args.orgId, async (tx) => {
    const tz = await readOrgTimeZone(tx, args.orgId);
    const rest = await restOfSeries(tx, args.orgId, args.visitId);
    const [newDay, time] = args.startLocal.split("T") as [string, string];
    const oldDay = orgLocalInput(rest[0]!.scheduled_start, tz).slice(0, 10);
    const shift = Math.round((Date.parse(`${newDay}T00:00:00Z`) - Date.parse(`${oldDay}T00:00:00Z`)) / 86_400_000);
    const moves = rest.map((v) => {
      const day = addDaysIso(orgLocalDate(v.scheduled_start, tz), shift);
      return { id: v.id, day, start: orgInstant(`${day}T${time}`, tz).toISOString() };
    });
    if (args.confirmDoubleBook) return { moves, conflicts: [] as SeriesConflict[] };
    const clinicianUserId = rest[0]!.clinician_user_id;
    const days = moves.map((m) => m.day);
    const conflicts = seriesConflicts({
      days,
      visitsByDay: await visitsByDay(tx, { orgId: args.orgId, clinicianUserId, tz, days, notVisitIds: rest.map((v) => v.id) }),
      capacity: await readCapacity(tx, args.orgId),
      timeOff: await readTimeOff(tx, { orgId: args.orgId, clinicianUserId, from: days[0]!, to: days.at(-1)! }),
    });
    return { moves, conflicts };
  });
  if (plan.conflicts.length > 0) return { moved: [], conflicts: plan.conflicts };

  const moved: Extract<SeriesMoveResult, { conflicts: [] }>["moved"] = [];
  for (const m of plan.moves) {
    const r = await rescheduleVisit({ orgId: args.orgId, id: m.id, scheduledStart: m.start, actorUserId: args.actorUserId });
    if (r.moved) moved.push({ id: m.id, ...r.moved });
  }
  return { moved, conflicts: [] };
}
