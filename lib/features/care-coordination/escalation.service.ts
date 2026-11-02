/**
 * Escalation alerts (0116; Level-1 doc:55-57). A reading that crosses the NP's
 * parameters raises an alert, in the same transaction as the reading, and the
 * patient's primary NP is notified. One alert per source and measure: a
 * corrected reading updates it, or withdraws it when it no longer crosses; a
 * voided call or event withdraws its alerts. Mark Q11e default: alerts, with
 * tasks made by hand.
 *
 * Audited with the measure (a closed set) and ids, never the reading.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import {
  crossedRules,
  eventRuleFor,
  type EscalationMeasure,
  type EscalationReadings,
} from "@/lib/features/care-plans/care-plan.types";

import type { AlertStatus, EscalationAlertView } from "./care-coordination.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

type ReadingSource = { kind: "vitals"; visitId: string } | { kind: "phone"; phoneEncounterId: string };
type AnySource = ReadingSource | { kind: "event"; eventId: string };

async function planRules(tx: Tx, orgId: string, patientId: string): Promise<unknown> {
  const r = await tx.$queryRaw<{ escalation: unknown }[]>`
    SELECT escalation FROM care_plan WHERE patient_id = ${patientId}::uuid AND org_id = ${orgId}::uuid
  `;
  return r[0]?.escalation ?? [];
}

async function primaryNp(tx: Tx, orgId: string, patientId: string): Promise<string | null> {
  const r = await tx.$queryRaw<{ np: string | null }[]>`
    SELECT primary_np_user_id AS np FROM patient WHERE id = ${patientId}::uuid AND org_id = ${orgId}::uuid
  `;
  return r[0]?.np ?? null;
}

/** The bell: which patient and which measure, never the reading. */
async function notifyNp(tx: Tx, orgId: string, np: string | null, patientId: string, alertId: string, measure: EscalationMeasure) {
  if (!np) return;
  await tx.$executeRaw`
    INSERT INTO notification (org_id, user_id, kind, payload)
    VALUES (${orgId}::uuid, ${np}::uuid, 'escalation_alert',
            ${JSON.stringify({ patientId, alertId, measure })}::jsonb)
  `;
}

async function audit(tx: Tx, orgId: string, userId: string | null, patientId: string, payload: Record<string, unknown>) {
  await writeAudit(tx, { orgId, userId, action: "escalation_alert", targetType: "patient", targetId: patientId, payload });
}

/** An alert seen to or withdrawn leaves nothing waiting in the bell. */
async function clearBell(tx: Tx, orgId: string, alertId: string) {
  await tx.$executeRaw`
    UPDATE notification SET read_at = now()
     WHERE org_id = ${orgId}::uuid AND kind = 'escalation_alert'
       AND payload->>'alertId' = ${alertId} AND read_at IS NULL
  `;
}

async function existingFor(tx: Tx, orgId: string, source: AnySource) {
  return source.kind === "vitals"
    ? tx.$queryRaw<{ id: string; measure: EscalationMeasure; status: AlertStatus }[]>`
        SELECT id, measure, status FROM escalation_alert
         WHERE visit_id = ${source.visitId}::uuid AND org_id = ${orgId}::uuid
      `
    : source.kind === "phone"
      ? tx.$queryRaw<{ id: string; measure: EscalationMeasure; status: AlertStatus }[]>`
          SELECT id, measure, status FROM escalation_alert
           WHERE phone_encounter_id = ${source.phoneEncounterId}::uuid AND org_id = ${orgId}::uuid
        `
      : tx.$queryRaw<{ id: string; measure: EscalationMeasure; status: AlertStatus }[]>`
          SELECT id, measure, status FROM escalation_alert
           WHERE event_id = ${source.eventId}::uuid AND org_id = ${orgId}::uuid
        `;
}

/**
 * A visit's vitals or a call's scores as they now stand. Raises what crosses,
 * updates what still does, withdraws an open alert that no longer does.
 */
export async function raiseForReadings(
  tx: Tx,
  args: { orgId: string; userId: string | null; patientId: string; source: ReadingSource; readings: EscalationReadings },
): Promise<void> {
  const crossed = crossedRules(await planRules(tx, args.orgId, args.patientId), args.readings);
  const existing = await existingFor(tx, args.orgId, args.source);
  if (crossed.length === 0 && existing.length === 0) return;
  const np = crossed.length > 0 ? await primaryNp(tx, args.orgId, args.patientId) : null;
  const source = args.source.kind;
  const visitId = args.source.kind === "vitals" ? args.source.visitId : null;
  const phoneId = args.source.kind === "phone" ? args.source.phoneEncounterId : null;

  for (const c of crossed) {
    const had = existing.find((e) => e.measure === c.measure);
    if (!had) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO escalation_alert (org_id, patient_id, measure, value, threshold, source, visit_id,
                                      phone_encounter_id, notified_user_id)
        VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${c.measure}, ${c.value}, ${c.threshold}, ${source},
                ${visitId}::uuid, ${phoneId}::uuid, ${np}::uuid)
        RETURNING id
      `;
      await notifyNp(tx, args.orgId, np, args.patientId, rows[0]!.id, c.measure);
      await audit(tx, args.orgId, args.userId, args.patientId, { op: "raise", alertId: rows[0]!.id, measure: c.measure, source });
    } else if (had.status === "withdrawn") {
      // Corrected back above the limit: raised again, and said again.
      await tx.$executeRaw`
        UPDATE escalation_alert SET status = 'open', value = ${c.value}, threshold = ${c.threshold},
               notified_user_id = ${np}::uuid, raised_at = now()
         WHERE id = ${had.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      await notifyNp(tx, args.orgId, np, args.patientId, had.id, c.measure);
      await audit(tx, args.orgId, args.userId, args.patientId, { op: "raise", alertId: had.id, measure: c.measure, source });
    } else {
      await tx.$executeRaw`
        UPDATE escalation_alert SET value = ${c.value}, threshold = ${c.threshold}
         WHERE id = ${had.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
    }
  }
  // An open alert whose reading was corrected below the limit. One already
  // acknowledged stays as it was: the NP has seen it.
  for (const e of existing) {
    if (e.status !== "open" || crossed.some((c) => c.measure === e.measure)) continue;
    await tx.$executeRaw`
      UPDATE escalation_alert SET status = 'withdrawn' WHERE id = ${e.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await clearBell(tx, args.orgId, e.id);
    await audit(tx, args.orgId, args.userId, args.patientId, { op: "withdraw", alertId: e.id, measure: e.measure, source });
  }
}

/** A fall, an ED visit or an admission the plan asks to hear of. */
export async function raiseForEvent(
  tx: Tx,
  args: { orgId: string; userId: string | null; patientId: string; eventId: string; kind: string },
): Promise<void> {
  const measure = eventRuleFor(await planRules(tx, args.orgId, args.patientId), args.kind);
  if (!measure) return;
  const np = await primaryNp(tx, args.orgId, args.patientId);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO escalation_alert (org_id, patient_id, measure, source, event_id, notified_user_id)
    VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${measure}, 'event', ${args.eventId}::uuid, ${np}::uuid)
    ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (!rows[0]) return;
  await notifyNp(tx, args.orgId, np, args.patientId, rows[0].id, measure);
  await audit(tx, args.orgId, args.userId, args.patientId, { op: "raise", alertId: rows[0].id, measure, source: "event" });
}

/** A call or an event voided as recorded in error: its open alerts go with it. */
export async function withdrawForSource(
  tx: Tx,
  args: { orgId: string; userId: string | null; patientId: string; source: { kind: "phone"; phoneEncounterId: string } | { kind: "event"; eventId: string } },
): Promise<void> {
  const open = (await existingFor(tx, args.orgId, args.source)).filter((e) => e.status === "open");
  for (const e of open) {
    await tx.$executeRaw`
      UPDATE escalation_alert SET status = 'withdrawn' WHERE id = ${e.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await clearBell(tx, args.orgId, e.id);
    await audit(tx, args.orgId, args.userId, args.patientId, { op: "withdraw", alertId: e.id, measure: e.measure, source: args.source.kind });
  }
}

/** The NP has seen it (doc:57). Its bell entries are read with it. */
export async function acknowledgeAlert(args: {
  orgId: string; userId: string; alertId: string; note?: string;
}): Promise<{ patientId: string }> {
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ patient_id: string; status: AlertStatus; measure: EscalationMeasure }[]>`
      SELECT patient_id, status, measure FROM escalation_alert
       WHERE id = ${args.alertId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Alert not found.");
    if (cur[0].status !== "open") {
      throw new ValidationError(cur[0].status === "acknowledged" ? "This alert is already acknowledged." : "This alert was withdrawn.");
    }
    await tx.$executeRaw`
      UPDATE escalation_alert SET status = 'acknowledged', acknowledged_by_user_id = ${args.userId}::uuid,
             acknowledged_at = now(), acknowledge_note = ${args.note?.trim() || null}
       WHERE id = ${args.alertId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await clearBell(tx, args.orgId, args.alertId);
    await audit(tx, args.orgId, args.userId, cur[0].patient_id, {
      op: "acknowledge", alertId: args.alertId, measure: cur[0].measure,
    });
    return { patientId: cur[0].patient_id };
  });
}

export async function listAlerts(args: {
  orgId: string;
  patientId?: string;
  /** The alerts this user was told of. */
  notifiedUserId?: string;
  status?: AlertStatus;
  limit?: number;
}): Promise<EscalationAlertView[]> {
  const limit = Math.min(200, args.limit ?? 50);
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string; patient_id: string; patient_name: string | null; measure: EscalationMeasure; value: string | null;
        threshold: string | null; source: EscalationAlertView["source"]; visit_id: string | null;
        phone_encounter_id: string | null; event_id: string | null; notified_user_id: string | null;
        notified_name: string | null; status: AlertStatus; raised_at: Date; acknowledged_by_name: string | null;
        acknowledged_at: Date | null; acknowledge_note: string | null;
      }[]
    >`
      SELECT a.id, a.patient_id, TRIM(p.first_name || ' ' || p.last_name) AS patient_name, a.measure,
             a.value::text AS value, a.threshold::text AS threshold, a.source, a.visit_id, a.phone_encounter_id,
             a.event_id, a.notified_user_id, COALESCE(nu.full_name, nu.email) AS notified_name, a.status,
             a.raised_at, COALESCE(au.full_name, au.email) AS acknowledged_by_name, a.acknowledged_at,
             a.acknowledge_note
        FROM escalation_alert a
        JOIN patient p ON p.id = a.patient_id AND p.org_id = a.org_id
        LEFT JOIN app_user nu ON nu.id = a.notified_user_id
        LEFT JOIN app_user au ON au.id = a.acknowledged_by_user_id
       WHERE a.org_id = ${args.orgId}::uuid
         AND (${args.patientId ?? null}::uuid IS NULL OR a.patient_id = ${args.patientId ?? null}::uuid)
         AND (${args.notifiedUserId ?? null}::uuid IS NULL OR a.notified_user_id = ${args.notifiedUserId ?? null}::uuid)
         AND (${args.status ?? null}::text IS NULL OR a.status = ${args.status ?? null})
       ORDER BY a.raised_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id, patientId: r.patient_id, patientName: r.patient_name, measure: r.measure,
      value: r.value === null ? null : Number(r.value), threshold: r.threshold === null ? null : Number(r.threshold),
      source: r.source, visitId: r.visit_id, phoneEncounterId: r.phone_encounter_id, eventId: r.event_id,
      notifiedUserId: r.notified_user_id, notifiedName: r.notified_name, status: r.status,
      raisedAt: r.raised_at.toISOString(), acknowledgedByName: r.acknowledged_by_name,
      acknowledgedAt: r.acknowledged_at?.toISOString() ?? null, acknowledgeNote: r.acknowledge_note,
    }));
  });
}
