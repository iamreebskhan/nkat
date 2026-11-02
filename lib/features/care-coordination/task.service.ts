/**
 * Tasks to the interdisciplinary team (0116; Level-1 doc:40, :54). A task
 * names a discipline and, once someone has it, a person; it is done or
 * cancelled with a note, never deleted. The person it is assigned to is told
 * in the bell. Audited with its discipline and field names, never its title or
 * details.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import type { Discipline } from "@/lib/features/care-plans/care-plan.types";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import type { CreateTask, TaskStatus, TaskView, UpdateTask } from "./care-coordination.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

async function today(tx: Tx, orgId: string): Promise<string> {
  return orgToday(await readOrgTimeZone(tx, orgId));
}

/** An active member of this org: nobody else can be handed a task. */
async function assertMember(tx: Tx, orgId: string, userId: string): Promise<void> {
  const m = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM org_member
     WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid AND status = 'active'
     LIMIT 1
  `;
  if (!m[0]) throw new ValidationError("That person is not an active member of this practice.");
}

async function notifyAssignee(tx: Tx, orgId: string, assignee: string, by: string, taskId: string, patientId: string | null) {
  if (assignee === by) return;
  // Who and about whom; never the task's own words.
  await tx.$executeRaw`
    INSERT INTO notification (org_id, user_id, kind, payload)
    VALUES (${orgId}::uuid, ${assignee}::uuid, 'care_task_assigned',
            ${JSON.stringify({ taskId, patientId, byUserId: by })}::jsonb)
  `;
}

export async function createTask(args: { orgId: string; userId: string; payload: CreateTask }): Promise<{ id: string }> {
  const t = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    let patientId = t.patientId ?? null;
    if (t.visitId) {
      const v = await tx.$queryRaw<{ patient_id: string }[]>`
        SELECT patient_id FROM visit WHERE id = ${t.visitId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      if (!v[0] || (patientId && v[0].patient_id !== patientId)) throw new ValidationError("That visit is not this patient's.");
      patientId = v[0].patient_id;
    }
    if (t.phoneEncounterId) {
      const c = await tx.$queryRaw<{ patient_id: string }[]>`
        SELECT patient_id FROM phone_encounter WHERE id = ${t.phoneEncounterId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      if (!c[0] || (patientId && c[0].patient_id !== patientId)) throw new ValidationError("That call is not this patient's.");
      patientId = c[0].patient_id;
    }
    if (t.alertId) {
      const a = await tx.$queryRaw<{ patient_id: string }[]>`
        SELECT patient_id FROM escalation_alert WHERE id = ${t.alertId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      if (!a[0] || (patientId && a[0].patient_id !== patientId)) throw new ValidationError("That alert is not this patient's.");
      patientId = a[0].patient_id;
    }
    // A chaplaincy task about a patient goes to their chaplain unless someone
    // else is named; with none (or one no longer active) it waits for the
    // discipline to pick up, as any task does.
    let assigneeUserId = t.assigneeUserId ?? null;
    if (patientId) {
      const p = await tx.$queryRaw<{ id: string; chaplain: string | null }[]>`
        SELECT p.id, m.user_id AS chaplain
          FROM patient p
          LEFT JOIN org_member m ON m.user_id = p.chaplain_user_id AND m.org_id = p.org_id AND m.status = 'active'
         WHERE p.id = ${patientId}::uuid AND p.org_id = ${args.orgId}::uuid
      `;
      if (!p[0]) throw new NotFoundError("Patient not found.");
      if (!assigneeUserId && t.discipline === "chaplaincy") assigneeUserId = p[0].chaplain;
    }
    if (t.assigneeUserId) await assertMember(tx, args.orgId, t.assigneeUserId);
    if (t.dueOn && t.dueOn < (await today(tx, args.orgId))) throw new ValidationError("The due day has passed. Pick today or a later day.");

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO care_task (org_id, patient_id, title, details, discipline, assignee_user_id, due_on,
                             visit_id, phone_encounter_id, alert_id, created_by_user_id)
      VALUES (${args.orgId}::uuid, ${patientId}::uuid, ${t.title.trim()}, ${t.details?.trim() || null}, ${t.discipline},
              ${assigneeUserId}::uuid, ${t.dueOn ?? null}::date, ${t.visitId ?? null}::uuid,
              ${t.phoneEncounterId ?? null}::uuid, ${t.alertId ?? null}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    const id = rows[0]!.id;
    if (assigneeUserId) await notifyAssignee(tx, args.orgId, assigneeUserId, args.userId, id, patientId);
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "care_task",
      targetType: patientId ? "patient" : "care_task", targetId: patientId ?? id,
      payload: { op: "create", taskId: id, discipline: t.discipline, assigned: Boolean(assigneeUserId) },
    });
    return { id };
  });
}

/**
 * Change an open task, or close it. Who may: anyone who can edit charts, for
 * anything; the person it is assigned to, to mark it done or cancel it.
 */
export async function updateTask(args: {
  orgId: string; userId: string; taskId: string; payload: UpdateTask; canEditAny: boolean;
}): Promise<{ updated: true }> {
  const u = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<
      { patient_id: string | null; status: TaskStatus; assignee_user_id: string | null; discipline: Discipline }[]
    >`
      SELECT patient_id, status, assignee_user_id, discipline FROM care_task
       WHERE id = ${args.taskId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    const t = cur[0];
    if (!t) throw new NotFoundError("Task not found.");
    if (t.status !== "open") throw new ValidationError(`This task is already ${t.status === "done" ? "done" : "cancelled"}.`);
    const mine = t.assignee_user_id === args.userId;
    const target = { targetType: t.patient_id ? ("patient" as const) : ("care_task" as const), targetId: t.patient_id ?? args.taskId };

    if ("done" in u || "cancel" in u) {
      if (!args.canEditAny && !mine) {
        throw new ValidationError("Only the person this task is assigned to, or someone who can edit charts, can close it.");
      }
      const done = "done" in u;
      const note = done ? u.done.note?.trim() || null : u.cancel.reason.trim();
      await tx.$executeRaw`
        UPDATE care_task SET status = ${done ? "done" : "cancelled"}, closed_by_user_id = ${args.userId}::uuid,
               closed_at = now(), close_note = ${note}, updated_at = now()
         WHERE id = ${args.taskId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      await writeAudit(tx, {
        orgId: args.orgId, userId: args.userId, action: "care_task", ...target,
        payload: { op: done ? "done" : "cancel", taskId: args.taskId, discipline: t.discipline },
      });
      return { updated: true };
    }

    if (!args.canEditAny) throw new ValidationError("Changing a task needs the permission to edit charts.");
    if (u.assigneeUserId) await assertMember(tx, args.orgId, u.assigneeUserId);
    if (u.dueOn && u.dueOn < (await today(tx, args.orgId))) throw new ValidationError("The due day has passed. Pick today or a later day.");
    const sent = (v: unknown) => v !== undefined;
    await tx.$executeRaw`
      UPDATE care_task SET
        title            = CASE WHEN ${sent(u.title)} THEN ${u.title?.trim() ?? null} ELSE title END,
        details          = CASE WHEN ${sent(u.details)} THEN ${u.details?.trim() || null} ELSE details END,
        discipline       = CASE WHEN ${sent(u.discipline)} THEN ${u.discipline ?? null} ELSE discipline END,
        assignee_user_id = CASE WHEN ${sent(u.assigneeUserId)} THEN ${u.assigneeUserId ?? null}::uuid ELSE assignee_user_id END,
        due_on           = CASE WHEN ${sent(u.dueOn)} THEN ${u.dueOn ?? null}::date ELSE due_on END,
        updated_at = now()
      WHERE id = ${args.taskId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (u.assigneeUserId && u.assigneeUserId !== t.assignee_user_id) {
      await notifyAssignee(tx, args.orgId, u.assigneeUserId, args.userId, args.taskId, t.patient_id);
    }
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "care_task", ...target,
      payload: {
        op: "edit", taskId: args.taskId, discipline: u.discipline ?? t.discipline,
        fields: Object.keys(u).filter((k) => sent(u[k as keyof typeof u])),
      },
    });
    return { updated: true };
  });
}

export type TaskScope =
  | { kind: "patient"; patientId: string }
  /** Assigned to this person. */
  | { kind: "assigned"; userId: string }
  /** Nobody's yet, for the patients this person is on the care team of (or any, for a discipline). */
  | { kind: "unassigned"; discipline?: Discipline }
  | { kind: "created"; userId: string };

/** The tasks, and the practice's today: the earliest due day a new one can take. */
export async function listTasks(args: {
  orgId: string; scope: TaskScope; status?: "open" | "closed" | "all"; limit?: number;
}): Promise<{ today: string; rows: TaskView[] }> {
  const limit = Math.min(300, args.limit ?? 100);
  const s = args.scope;
  const status = args.status ?? "open";
  return withOrgContext(args.orgId, async (tx) => {
    const day = await today(tx, args.orgId);
    const rows = await tx.$queryRaw<
      {
        id: string; patient_id: string | null; patient_name: string | null; title: string; details: string | null;
        discipline: Discipline; assignee_user_id: string | null; assignee_name: string | null; due_on: string | null;
        status: TaskStatus; visit_id: string | null; phone_encounter_id: string | null; alert_id: string | null;
        created_by_user_id: string | null; created_by_name: string | null; created_at: Date;
        closed_by_name: string | null; closed_at: Date | null; close_note: string | null;
      }[]
    >`
      SELECT t.id, t.patient_id, TRIM(p.first_name || ' ' || p.last_name) AS patient_name, t.title, t.details,
             t.discipline, t.assignee_user_id, COALESCE(au.full_name, au.email) AS assignee_name,
             to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.status, t.visit_id, t.phone_encounter_id, t.alert_id,
             t.created_by_user_id, COALESCE(cu.full_name, cu.email) AS created_by_name, t.created_at,
             COALESCE(xu.full_name, xu.email) AS closed_by_name, t.closed_at, t.close_note
        FROM care_task t
        LEFT JOIN patient p ON p.id = t.patient_id AND p.org_id = t.org_id
        LEFT JOIN app_user au ON au.id = t.assignee_user_id
        LEFT JOIN app_user cu ON cu.id = t.created_by_user_id
        LEFT JOIN app_user xu ON xu.id = t.closed_by_user_id
       WHERE t.org_id = ${args.orgId}::uuid
         AND (${status}::text = 'all' OR (${status}::text = 'open') = (t.status = 'open'))
         AND CASE ${s.kind}::text
               WHEN 'patient' THEN t.patient_id = ${s.kind === "patient" ? s.patientId : null}::uuid
               WHEN 'assigned' THEN t.assignee_user_id = ${s.kind === "assigned" ? s.userId : null}::uuid
               WHEN 'created' THEN t.created_by_user_id = ${s.kind === "created" ? s.userId : null}::uuid
               ELSE t.assignee_user_id IS NULL
                    AND (${s.kind === "unassigned" ? (s.discipline ?? null) : null}::text IS NULL
                         OR t.discipline = ${s.kind === "unassigned" ? (s.discipline ?? null) : null})
             END
       ORDER BY (t.status = 'open') DESC, t.due_on NULLS LAST, t.created_at DESC
       LIMIT ${limit}
    `;
    return {
      today: day,
      rows: rows.map((r) => ({
        id: r.id, patientId: r.patient_id, patientName: r.patient_name, title: r.title, details: r.details,
        discipline: r.discipline, assigneeUserId: r.assignee_user_id, assigneeName: r.assignee_name, dueOn: r.due_on,
        overdue: r.status === "open" && r.due_on !== null && r.due_on < day, status: r.status, visitId: r.visit_id,
        phoneEncounterId: r.phone_encounter_id, alertId: r.alert_id, createdByUserId: r.created_by_user_id,
        createdByName: r.created_by_name, createdAt: r.created_at.toISOString(), closedByName: r.closed_by_name,
        closedAt: r.closed_at?.toISOString() ?? null, closeNote: r.close_note,
      })),
    };
  });
}
