/**
 * My caseload (0116; Level-1 doc:48, :51): the patients under care whose care
 * team I am on, with what needs doing between visits: open alerts and tasks,
 * the monitoring the care plan asks for and when it falls due, the plan's
 * review, and the next visit. Days are the practice's.
 */
import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { monitoringDue, type MonitoringHow, type MonitoringItem } from "@/lib/features/care-plans/care-plan.types";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import type { PatientAcuity } from "@/lib/features/patients/patient.types";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";

import type { CareProgram } from "./care-coordination.types";

export type CareTeamSeat = "primary_np" | "rn" | "social_worker" | "chaplain" | "billing_agent";

export interface CaseloadRow {
  patientId: string;
  name: string;
  acuity: PatientAcuity | null;
  /** Where I sit on this patient's care team. */
  seats: CareTeamSeat[];
  lastVisitOn: string | null;
  nextVisitOn: string | null;
  lastCallOn: string | null;
  openTasks: number;
  openAlerts: number;
  /** Monitoring the plan asks for that has come due. */
  due: { item: string; how: MonitoringHow; dueOn: string; overdue: boolean }[];
  reviewOn: string | null;
  reviewDue: boolean;
  programs: CareProgram[];
}

interface Row {
  id: string; name: string; acuity: PatientAcuity | null; admitted_on: string | null;
  np: boolean; rn: boolean; sw: boolean; ch: boolean; ba: boolean;
  last_visit_on: string | null; next_visit_on: string | null; last_call_on: string | null;
  open_tasks: number; open_alerts: number; monitoring: MonitoringItem[] | null; review_on: string | null;
  programs: CareProgram[];
}

export interface FollowUpView {
  today: string;
  admittedOn: string | null;
  lastVisitOn: string | null;
  lastCallOn: string | null;
  /** Each monitored item with its last contact and when it falls due (doc:51). */
  monitoring: {
    item: string; how: MonitoringHow; everyDays: number | null; lastOn: string | null; dueOn: string | null; overdue: boolean;
  }[];
  reviewOn: string | null;
  reviewDue: boolean;
}

/** One patient's follow-up: what the care plan asks to be monitored, and when it is due. */
export async function getFollowUp(args: { orgId: string; patientId: string }): Promise<FollowUpView> {
  return withOrgContext(args.orgId, async (tx) => {
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    const rows = await tx.$queryRaw<
      {
        admitted_on: string | null; last_visit_on: string | null; last_call_on: string | null;
        monitoring: MonitoringItem[] | null; review_on: string | null;
      }[]
    >`
      SELECT to_char(p.admitted_on, 'YYYY-MM-DD') AS admitted_on,
             (SELECT to_char((COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD')
                FROM visit v
               WHERE v.patient_id = p.id AND v.org_id = p.org_id
                 AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
                 AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
                 AND COALESCE(v.start_time, v.scheduled_start) <= now()
               ORDER BY COALESCE(v.start_time, v.scheduled_start) DESC LIMIT 1) AS last_visit_on,
             (SELECT to_char((c.occurred_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD')
                FROM phone_encounter c
               WHERE c.patient_id = p.id AND c.org_id = p.org_id AND c.voided_at IS NULL
               ORDER BY c.occurred_at DESC LIMIT 1) AS last_call_on,
             cp.monitoring, to_char(cp.review_on, 'YYYY-MM-DD') AS review_on
        FROM patient p
        JOIN org o ON o.id = p.org_id
        LEFT JOIN care_plan cp ON cp.patient_id = p.id AND cp.org_id = p.org_id
       WHERE p.id = ${args.patientId}::uuid AND p.org_id = ${args.orgId}::uuid
    `;
    const r = rows[0];
    if (!r) throw new NotFoundError("Patient not found.");
    const last = { phone: r.last_call_on, visit: r.last_visit_on, since: r.admitted_on };
    return {
      today,
      admittedOn: r.admitted_on,
      lastVisitOn: r.last_visit_on,
      lastCallOn: r.last_call_on,
      monitoring: (r.monitoring ?? []).map((m) => ({
        item: m.item, how: m.how, everyDays: m.everyDays, ...monitoringDue(m, last, today),
      })),
      reviewOn: r.review_on,
      reviewDue: r.review_on !== null && r.review_on <= today,
    };
  });
}

/** Where a row sits: what is overdue first, then the most acute. */
const ACUITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function listCaseload(args: { orgId: string; userId: string }): Promise<{ today: string; rows: CaseloadRow[] }> {
  return withOrgContext(args.orgId, async (tx) => {
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    const rows = await tx.$queryRaw<Row[]>`
      SELECT p.id, TRIM(p.first_name || ' ' || p.last_name) AS name, p.acuity,
             to_char(p.admitted_on, 'YYYY-MM-DD') AS admitted_on,
             COALESCE(p.primary_np_user_id = ${args.userId}::uuid, false) AS np,
             COALESCE(p.rn_user_id = ${args.userId}::uuid, false) AS rn,
             COALESCE(p.social_worker_user_id = ${args.userId}::uuid, false) AS sw,
             COALESCE(p.chaplain_user_id = ${args.userId}::uuid, false) AS ch,
             COALESCE(p.billing_agent_user_id = ${args.userId}::uuid, false) AS ba,
             lv.day AS last_visit_on, nv.day AS next_visit_on, lc.day AS last_call_on,
             (SELECT count(*) FROM care_task t
               WHERE t.patient_id = p.id AND t.org_id = p.org_id AND t.status = 'open')::int AS open_tasks,
             (SELECT count(*) FROM escalation_alert a
               WHERE a.patient_id = p.id AND a.org_id = p.org_id AND a.status = 'open')::int AS open_alerts,
             cp.monitoring, to_char(cp.review_on, 'YYYY-MM-DD') AS review_on,
             ARRAY(SELECT e.program FROM care_program_enrollment e
                    WHERE e.patient_id = p.id AND e.org_id = p.org_id AND e.ended_on IS NULL
                    ORDER BY e.program) AS programs
        FROM patient p
        JOIN org o ON o.id = p.org_id
        LEFT JOIN care_plan cp ON cp.patient_id = p.id AND cp.org_id = p.org_id
        -- The last visit that took place, and the next one booked. A PCM/CCM
        -- month's charge (0117) is carried on a visit, and is none.
        LEFT JOIN LATERAL (
          SELECT to_char((COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS day
            FROM visit v
           WHERE v.patient_id = p.id AND v.org_id = p.org_id
             AND v.status IN ('in_progress', 'documented', 'pending_billing', 'billed')
             AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
             AND COALESCE(v.start_time, v.scheduled_start) <= now()
           ORDER BY COALESCE(v.start_time, v.scheduled_start) DESC
           LIMIT 1) lv ON true
        LEFT JOIN LATERAL (
          SELECT to_char((v.scheduled_start AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS day
            FROM visit v
           WHERE v.patient_id = p.id AND v.org_id = p.org_id AND v.status IN ('scheduled', 'in_progress')
             AND v.scheduled_start > now()
           ORDER BY v.scheduled_start
           LIMIT 1) nv ON true
        LEFT JOIN LATERAL (
          SELECT to_char((c.occurred_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS day
            FROM phone_encounter c
           WHERE c.patient_id = p.id AND c.org_id = p.org_id AND c.voided_at IS NULL
           ORDER BY c.occurred_at DESC
           LIMIT 1) lc ON true
       WHERE p.org_id = ${args.orgId}::uuid
         AND p.status = 'active'
         AND ${args.userId}::uuid IN (p.primary_np_user_id, p.rn_user_id, p.social_worker_user_id, p.chaplain_user_id, p.billing_agent_user_id)
    `;
    const out = rows.map((r): CaseloadRow => {
      const due = (r.monitoring ?? [])
        .map((m) => ({ m, d: monitoringDue(m, { phone: r.last_call_on, visit: r.last_visit_on, since: r.admitted_on }, today) }))
        .filter(({ d }) => d.dueOn !== null && d.dueOn <= today)
        .map(({ m, d }) => ({ item: m.item, how: m.how, dueOn: d.dueOn!, overdue: d.overdue }));
      return {
        patientId: r.id,
        name: r.name,
        acuity: r.acuity,
        seats: [
          ...(r.np ? (["primary_np"] as const) : []),
          ...(r.rn ? (["rn"] as const) : []),
          ...(r.sw ? (["social_worker"] as const) : []),
          ...(r.ch ? (["chaplain"] as const) : []),
          ...(r.ba ? (["billing_agent"] as const) : []),
        ],
        lastVisitOn: r.last_visit_on,
        nextVisitOn: r.next_visit_on,
        lastCallOn: r.last_call_on,
        openTasks: r.open_tasks,
        openAlerts: r.open_alerts,
        due,
        reviewOn: r.review_on,
        reviewDue: r.review_on !== null && r.review_on <= today,
        programs: r.programs ?? [],
      };
    });
    const weight = (r: CaseloadRow) => (r.openAlerts > 0 ? 0 : r.due.some((d) => d.overdue) ? 1 : r.due.length > 0 || r.reviewDue ? 2 : 3);
    out.sort(
      (a, b) =>
        weight(a) - weight(b) ||
        (ACUITY_RANK[a.acuity ?? ""] ?? 4) - (ACUITY_RANK[b.acuity ?? ""] ?? 4) ||
        a.name.localeCompare(b.name),
    );
    return { today, rows: out };
  });
}
