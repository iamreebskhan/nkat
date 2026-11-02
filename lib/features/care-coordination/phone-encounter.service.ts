/**
 * Telephone encounters between visits (0116; Level-1 doc:52). Who called whom,
 * how long, symptom scores and a summary. The scores are checked against the
 * NP's escalation parameters in the same transaction; a call recorded in
 * error is voided, and its open alerts go with it. A call may count its
 * minutes toward a PCM/CCM enrolment's month (0117), in the same transaction:
 * the call is refused with the reason when the time cannot be counted, and
 * voiding it voids the time. Audited with ids only.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { orgLocalDate } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import type { CareProgram, CreatePhoneEncounter, PhoneEncounterView } from "./care-coordination.types";
import { insertTimeEntry, voidCallTime } from "./care-management.service";
import { raiseForReadings, withdrawForSource } from "./escalation.service";

/** A clock a little ahead of the server's is not a call from the future. */
const SKEW_MS = 5 * 60_000;

export async function createPhoneEncounter(args: {
  orgId: string; userId: string; patientId: string; payload: CreatePhoneEncounter;
}): Promise<{ id: string }> {
  const c = args.payload;
  const at = c.occurredAt ? new Date(c.occurredAt) : new Date();
  if (at.getTime() > Date.now() + SKEW_MS) throw new ValidationError("The call is in the future.");
  return withOrgContext(args.orgId, async (tx) => {
    const p = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!p[0]) throw new NotFoundError("Patient not found.");
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO phone_encounter (org_id, patient_id, clinician_user_id, occurred_at, direction, spoke_with, minutes,
                                   pain_score, dyspnea_score, nausea_score, summary)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${args.userId}::uuid, ${at}, ${c.direction}, ${c.spokeWith},
              ${c.minutes ?? null}::smallint, ${c.painScore ?? null}::smallint, ${c.dyspneaScore ?? null}::smallint,
              ${c.nauseaScore ?? null}::smallint, ${c.summary.trim()})
      RETURNING id
    `;
    const id = rows[0]!.id;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "phone_encounter", targetType: "patient", targetId: args.patientId,
      payload: { op: "add", encounterId: id, direction: c.direction },
    });
    if (c.countForEnrollmentId) {
      // The call's day where the practice is: the day its minutes are counted on.
      const zone = await readOrgTimeZone(tx, args.orgId);
      await insertTimeEntry(tx, {
        orgId: args.orgId, userId: args.userId, patientId: args.patientId, enrollmentId: c.countForEnrollmentId,
        serviceOn: orgLocalDate(at, zone), minutes: c.minutes!, activity: "phone", phoneEncounterId: id,
      });
    }
    await raiseForReadings(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId,
      source: { kind: "phone", phoneEncounterId: id },
      readings: { pain: c.painScore ?? null, dyspnea: c.dyspneaScore ?? null, nausea: c.nauseaScore ?? null },
    });
    return { id };
  });
}

export async function voidPhoneEncounter(args: {
  orgId: string; userId: string; patientId: string; encounterId: string; reason: string;
}): Promise<{ updated: true }> {
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM phone_encounter
       WHERE id = ${args.encounterId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Call not found.");
    if (cur[0].voided_at) throw new ValidationError("This call was already voided.");
    // The minutes it counted go with it, unless their month is charged: then
    // the call stands with the bill, and voiding it is refused.
    await voidCallTime(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId, phoneEncounterId: args.encounterId,
      reason: args.reason,
    });
    await tx.$executeRaw`
      UPDATE phone_encounter SET voided_at = now(), voided_by_user_id = ${args.userId}::uuid, void_reason = ${args.reason.trim()}
       WHERE id = ${args.encounterId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "phone_encounter", targetType: "patient", targetId: args.patientId,
      payload: { op: "void", encounterId: args.encounterId },
    });
    await withdrawForSource(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId,
      source: { kind: "phone", phoneEncounterId: args.encounterId },
    });
    return { updated: true };
  });
}

export async function listPhoneEncounters(args: { orgId: string; patientId: string; limit?: number }): Promise<PhoneEncounterView[]> {
  const limit = Math.min(200, args.limit ?? 100);
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string; clinician_user_id: string; clinician_name: string | null; occurred_at: Date; occurred_on: string;
        occurred_time: string;
        direction: PhoneEncounterView["direction"]; spoke_with: PhoneEncounterView["spokeWith"]; minutes: number | null;
        pain_score: number | null; dyspnea_score: number | null; nausea_score: number | null; summary: string;
        voided_at: Date | null; void_reason: string | null; counted_for: CareProgram | null;
      }[]
    >`
      SELECT c.id, c.clinician_user_id, COALESCE(u.full_name, u.email) AS clinician_name, c.occurred_at,
             to_char((c.occurred_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS occurred_on,
             to_char(c.occurred_at AT TIME ZONE o.timezone, 'HH24:MI') AS occurred_time,
             c.direction, c.spoke_with, c.minutes, c.pain_score, c.dyspnea_score, c.nausea_score, c.summary,
             c.voided_at, c.void_reason,
             (SELECT e.program FROM care_management_time t
                JOIN care_program_enrollment e ON e.id = t.enrollment_id AND e.org_id = t.org_id
               WHERE t.phone_encounter_id = c.id AND t.org_id = c.org_id AND t.voided_at IS NULL) AS counted_for
        FROM phone_encounter c
        JOIN org o ON o.id = c.org_id
        LEFT JOIN app_user u ON u.id = c.clinician_user_id
       WHERE c.patient_id = ${args.patientId}::uuid AND c.org_id = ${args.orgId}::uuid
       ORDER BY c.occurred_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id, clinicianUserId: r.clinician_user_id, clinicianName: r.clinician_name,
      occurredAt: r.occurred_at.toISOString(), occurredOn: r.occurred_on, occurredTime: r.occurred_time,
      direction: r.direction, spokeWith: r.spoke_with,
      minutes: r.minutes, painScore: r.pain_score, dyspneaScore: r.dyspnea_score, nauseaScore: r.nausea_score,
      summary: r.summary, voidedAt: r.voided_at?.toISOString() ?? null, voidReason: r.void_reason,
      countedFor: r.counted_for,
    }));
  });
}
