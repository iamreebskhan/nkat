/**
 * PCM/CCM enrolment (0116; Level-1 doc:38, :101): the program, the day, and
 * the consent that comes first (its day and how it was given). One enrolment
 * in force per patient and program; it ends with a day and a reason, and a
 * discharge ends it (clinical-course.service). Audited with the program.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";

import { CARE_PROGRAM_LABEL, type CareProgram, type Enroll, type EnrollmentView } from "./care-coordination.types";

export async function enroll(args: { orgId: string; userId: string; patientId: string; payload: Enroll }): Promise<{ id: string }> {
  const e = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const p = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM patient WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid FOR NO KEY UPDATE
    `;
    if (!p[0]) throw new NotFoundError("Patient not found.");
    if (p[0].status !== "active") throw new ValidationError("Only a patient under care can be enrolled.");
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    if (e.enrolledOn > today || e.consentOn > today) throw new ValidationError("The enrolment or the consent is after today.");
    const current = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM care_program_enrollment
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND program = ${e.program}
         AND ended_on IS NULL
    `;
    if (current[0]) throw new ValidationError(`Already enrolled in ${CARE_PROGRAM_LABEL[e.program]}.`);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO care_program_enrollment (org_id, patient_id, program, enrolled_on, consent_on, consent_method,
                                           consent_note, enrolled_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${e.program}, ${e.enrolledOn}::date, ${e.consentOn}::date,
              ${e.consentMethod}, ${e.consentNote?.trim() || null}, ${args.userId}::uuid)
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "care_program_enrollment", targetType: "patient", targetId: args.patientId,
      payload: { op: "enroll", enrollmentId: rows[0]!.id, program: e.program, consentMethod: e.consentMethod },
    });
    return { id: rows[0]!.id };
  });
}

export async function endEnrollment(args: {
  orgId: string; userId: string; patientId: string; enrollmentId: string; endedOn: string; reason: string;
}): Promise<{ updated: true }> {
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ program: CareProgram; enrolled_on: string; ended_on: string | null }[]>`
      SELECT program, to_char(enrolled_on, 'YYYY-MM-DD') AS enrolled_on, to_char(ended_on, 'YYYY-MM-DD') AS ended_on
        FROM care_program_enrollment
       WHERE id = ${args.enrollmentId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Enrolment not found.");
    if (cur[0].ended_on) throw new ValidationError(`This enrolment ended on ${cur[0].ended_on}.`);
    if (args.endedOn < cur[0].enrolled_on) throw new ValidationError(`Enrolled on ${cur[0].enrolled_on}; it cannot end earlier.`);
    if (args.endedOn > orgToday(await readOrgTimeZone(tx, args.orgId))) throw new ValidationError("The end is after today.");
    await tx.$executeRaw`
      UPDATE care_program_enrollment SET ended_on = ${args.endedOn}::date, end_reason = ${args.reason.trim()},
             ended_by_user_id = ${args.userId}::uuid
       WHERE id = ${args.enrollmentId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "care_program_enrollment", targetType: "patient", targetId: args.patientId,
      payload: { op: "end", enrollmentId: args.enrollmentId, program: cur[0].program },
    });
    return { updated: true };
  });
}

/** The enrolments, in force first, and the practice's today for the forms' days. */
export async function listEnrollments(args: { orgId: string; patientId: string }): Promise<{ today: string; rows: EnrollmentView[] }> {
  return withOrgContext(args.orgId, async (tx) => {
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    const rows = await tx.$queryRaw<
      {
        id: string; program: CareProgram; enrolled_on: string; consent_on: string; consent_method: "verbal" | "written";
        consent_note: string | null; enrolled_by_name: string | null; ended_on: string | null; end_reason: string | null;
      }[]
    >`
      SELECT e.id, e.program, to_char(e.enrolled_on, 'YYYY-MM-DD') AS enrolled_on,
             to_char(e.consent_on, 'YYYY-MM-DD') AS consent_on, e.consent_method, e.consent_note,
             COALESCE(u.full_name, u.email) AS enrolled_by_name, to_char(e.ended_on, 'YYYY-MM-DD') AS ended_on, e.end_reason
        FROM care_program_enrollment e
        LEFT JOIN app_user u ON u.id = e.enrolled_by_user_id
       WHERE e.patient_id = ${args.patientId}::uuid AND e.org_id = ${args.orgId}::uuid
       ORDER BY (e.ended_on IS NULL) DESC, e.enrolled_on DESC
    `;
    return {
      today,
      rows: rows.map((r) => ({
        id: r.id, program: r.program, enrolledOn: r.enrolled_on, consentOn: r.consent_on, consentMethod: r.consent_method,
        consentNote: r.consent_note, enrolledByName: r.enrolled_by_name, endedOn: r.ended_on, endReason: r.end_reason,
      })),
    };
  });
}
