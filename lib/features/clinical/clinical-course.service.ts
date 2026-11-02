/**
 * The course of care on the chart (0115; Level-1 doc:37, :58, :84-95, :108).
 *
 * Every write names the org as well as relying on RLS, checks its days against
 * the practice's today, and is audited with ids, kinds, sources and codes,
 * never what was written about the patient.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { raiseForEvent, withdrawForSource } from "@/lib/features/care-coordination/escalation.service";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import type { PatientAcuity } from "@/lib/features/patients/patient.types";

import {
  daysBetween,
  isHospiceCategory,
  readmissionIds,
  type AcuityEventView,
  type AddEvent,
  type ClinicalCourseView,
  type Discharge,
  type DischargeView,
  type HospiceAssessment,
  type HospiceStay,
  type PatientEventView,
  type Readmit,
  type UpdateEvent,
} from "./clinical-course.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

const OPEN_VISIT = ["scheduled", "in_progress"];

async function practiceToday(tx: Tx, orgId: string): Promise<string> {
  return orgToday(await readOrgTimeZone(tx, orgId));
}

/**
 * The patient, locked: a discharge and a readmission (or two of either) take
 * turns rather than both reading "under care". NO KEY, so rows that only
 * reference the patient are not held up.
 */
async function patientRow(
  tx: Tx,
  orgId: string,
  patientId: string,
): Promise<{ status: string; admitted_on: string | null }> {
  const p = await tx.$queryRaw<{ status: string; admitted_on: string | null }[]>`
    SELECT status, to_char(admitted_on, 'YYYY-MM-DD') AS admitted_on FROM patient
     WHERE id = ${patientId}::uuid AND org_id = ${orgId}::uuid
       FOR NO KEY UPDATE
  `;
  if (!p[0]) throw new NotFoundError("Patient not found.");
  return p[0];
}

const notAfter = (day: string | null | undefined, today: string, what: string) => {
  if (day && day > today) throw new ValidationError(`${what} is after today.`);
};

const iso = (d: Date) => d.toISOString();

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getClinicalCourse(args: { orgId: string; patientId: string }): Promise<ClinicalCourseView> {
  return withOrgContext(args.orgId, async (tx) => {
    const p = await tx.$queryRaw<{ status: string; admitted_on: string | null; acuity: PatientAcuity | null }[]>`
      SELECT status, to_char(admitted_on, 'YYYY-MM-DD') AS admitted_on, acuity FROM patient
       WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!p[0]) throw new NotFoundError("Patient not found.");
    const today = await practiceToday(tx, args.orgId);

    const acuity = await tx.$queryRaw<
      {
        id: string; acuity: PatientAcuity; source: AcuityEventView["source"]; visit_id: string | null;
        visit_day: string | null; recorded_by_name: string | null; recorded_at: Date;
      }[]
    >`
      SELECT e.id, e.acuity, e.source, e.visit_id,
             to_char((COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS visit_day,
             COALESCE(u.full_name, u.email) AS recorded_by_name, e.recorded_at
        FROM patient_acuity_event e
        JOIN org o ON o.id = e.org_id
        LEFT JOIN visit v ON v.id = e.visit_id AND v.org_id = e.org_id
        LEFT JOIN app_user u ON u.id = e.recorded_by_user_id
       WHERE e.patient_id = ${args.patientId}::uuid AND e.org_id = ${args.orgId}::uuid
       ORDER BY e.recorded_at DESC
       LIMIT 100
    `;

    const assessments = await tx.$queryRaw<
      {
        id: string; eligible: boolean; assessed_on: string; basis: string | null; visit_id: string | null;
        assessed_by_name: string | null; created_at: Date;
      }[]
    >`
      SELECT h.id, h.eligible, to_char(h.assessed_on, 'YYYY-MM-DD') AS assessed_on, h.basis, h.visit_id,
             COALESCE(u.full_name, u.email) AS assessed_by_name, h.created_at
        FROM hospice_eligibility_assessment h
        LEFT JOIN app_user u ON u.id = h.assessed_by_user_id
       WHERE h.patient_id = ${args.patientId}::uuid AND h.org_id = ${args.orgId}::uuid
       ORDER BY h.assessed_on DESC, h.created_at DESC
    `;
    // Triage days are the practice's, like every other day on the card.
    const triage = await tx.$queryRaw<{ hospice_eligible: "yes" | "no" | "unsure"; hospice_basis: string | null; triaged_on: string }[]>`
      SELECT t.hospice_eligible, t.hospice_basis,
             to_char((t.triaged_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS triaged_on
        FROM referral r
        JOIN referral_triage t ON t.referral_id = r.id AND t.org_id = r.org_id
        JOIN org o ON o.id = r.org_id
       WHERE r.patient_id = ${args.patientId}::uuid AND r.org_id = ${args.orgId}::uuid
         AND t.hospice_eligible IS NOT NULL
       ORDER BY t.triaged_at DESC
       LIMIT 1
    `;
    // The triage's acuity from the referral itself: a chart admitted before
    // the history began has no triage event to show it.
    const triageAcuity = await tx.$queryRaw<{ preliminary_acuity: PatientAcuity; triaged_on: string }[]>`
      SELECT t.preliminary_acuity,
             to_char((t.triaged_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS triaged_on
        FROM referral r
        JOIN referral_triage t ON t.referral_id = r.id AND t.org_id = r.org_id
        JOIN org o ON o.id = r.org_id
       WHERE r.patient_id = ${args.patientId}::uuid AND r.org_id = ${args.orgId}::uuid
         AND t.preliminary_acuity IS NOT NULL
       ORDER BY t.triaged_at DESC
       LIMIT 1
    `;

    const events = await tx.$queryRaw<
      {
        id: string; kind: PatientEventView["kind"]; occurred_on: string; ended_on: string | null;
        facility: string | null; injury: boolean | null; description: string | null;
        recorded_by_name: string | null; recorded_at: Date; voided_at: Date | null; void_reason: string | null;
      }[]
    >`
      SELECT e.id, e.kind, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
             to_char(e.ended_on, 'YYYY-MM-DD') AS ended_on, e.facility, e.injury, e.description,
             COALESCE(u.full_name, u.email) AS recorded_by_name, e.recorded_at, e.voided_at, e.void_reason
        FROM patient_event e
        LEFT JOIN app_user u ON u.id = e.recorded_by_user_id
       WHERE e.patient_id = ${args.patientId}::uuid AND e.org_id = ${args.orgId}::uuid
       ORDER BY e.occurred_on DESC, e.recorded_at DESC
    `;
    const eventViews = events.map((e) => ({
      id: e.id, kind: e.kind, occurredOn: e.occurred_on, endedOn: e.ended_on, facility: e.facility,
      injury: e.injury, description: e.description, readmission: false,
      recordedByName: e.recorded_by_name, recordedAt: iso(e.recorded_at),
      voidedAt: e.voided_at ? iso(e.voided_at) : null, voidReason: e.void_reason,
    }));
    const readmissions = readmissionIds(eventViews);
    for (const e of eventViews) e.readmission = readmissions.has(e.id);

    const discharges = await readDischarges(tx, args.orgId, args.patientId);

    return {
      status: p[0].status,
      admittedOn: p[0].admitted_on,
      practiceToday: today,
      acuity: {
        current: p[0].acuity,
        triage: triageAcuity[0] ? { acuity: triageAcuity[0].preliminary_acuity, on: triageAcuity[0].triaged_on } : null,
        history: acuity.map((a) => ({
          id: a.id, acuity: a.acuity, source: a.source, visitId: a.visit_id, visitDay: a.visit_day,
          recordedByName: a.recorded_by_name, recordedAt: iso(a.recorded_at),
        })),
      },
      hospice: {
        assessments: assessments.map((h) => ({
          id: h.id, eligible: h.eligible, assessedOn: h.assessed_on, basis: h.basis, visitId: h.visit_id,
          assessedByName: h.assessed_by_name, createdAt: iso(h.created_at),
        })),
        triage: triage[0]
          ? { eligible: triage[0].hospice_eligible, basis: triage[0].hospice_basis, on: triage[0].triaged_on }
          : null,
      },
      events: eventViews,
      discharges,
    };
  });
}

async function readDischarges(tx: Tx, orgId: string, patientId: string): Promise<DischargeView[]> {
  const rows = await tx.$queryRaw<
    {
      id: string; admitted_on: string | null; discharged_on: string; code: string; label: string; category: string;
      note: string | null; hospice_name: string | null; hospice_admitted_on: string | null;
      hospice_ended_on: string | null; hospice_end_reason: DischargeView["hospiceEndReason"]; died_on: string | null;
      recorded_by_name: string | null; recorded_at: Date; reversed_at: Date | null; reversed_reason: string | null;
    }[]
  >`
    SELECT d.id, to_char(d.admitted_on, 'YYYY-MM-DD') AS admitted_on,
           to_char(d.discharged_on, 'YYYY-MM-DD') AS discharged_on,
           rc.code, rc.label, rc.category, d.note, d.hospice_name,
           to_char(d.hospice_admitted_on, 'YYYY-MM-DD') AS hospice_admitted_on,
           to_char(d.hospice_ended_on, 'YYYY-MM-DD') AS hospice_ended_on, d.hospice_end_reason,
           to_char(d.died_on, 'YYYY-MM-DD') AS died_on,
           COALESCE(u.full_name, u.email) AS recorded_by_name, d.recorded_at, d.reversed_at, d.reversed_reason
      FROM patient_discharge d
      JOIN org_reason_code rc ON rc.id = d.reason_code_id AND rc.org_id = d.org_id
      LEFT JOIN app_user u ON u.id = d.recorded_by_user_id
     WHERE d.patient_id = ${patientId}::uuid AND d.org_id = ${orgId}::uuid
     ORDER BY d.recorded_at DESC
  `;
  return rows.map((d) => ({
    id: d.id, admittedOn: d.admitted_on, dischargedOn: d.discharged_on, reasonCode: d.code, reasonLabel: d.label,
    category: d.category, note: d.note, hospiceName: d.hospice_name, hospiceAdmittedOn: d.hospice_admitted_on,
    hospiceEndedOn: d.hospice_ended_on, hospiceEndReason: d.hospice_end_reason, diedOn: d.died_on,
    lengthOfStayDays: daysBetween(d.admitted_on, d.discharged_on),
    hospiceLengthOfStayDays: daysBetween(d.hospice_admitted_on, d.hospice_ended_on),
    recordedByName: d.recorded_by_name, recordedAt: iso(d.recorded_at),
    reversedAt: d.reversed_at ? iso(d.reversed_at) : null, reversedReason: d.reversed_reason,
  }));
}

// ---------------------------------------------------------------------------
// Acuity at a visit (Mark Q9: the NP's value, apart from the triage's)
// ---------------------------------------------------------------------------

export async function getVisitAcuity(args: { orgId: string; visitId: string }): Promise<{ acuity: PatientAcuity | null }> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ acuity: PatientAcuity }[]>`
      SELECT acuity FROM patient_acuity_event
       WHERE visit_id = ${args.visitId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    return { acuity: rows[0]?.acuity ?? null };
  });
}

export async function setVisitAcuity(args: {
  orgId: string; userId: string; visitId: string; acuity: PatientAcuity;
}): Promise<void> {
  return withOrgContext(args.orgId, async (tx) => {
    const v = await tx.$queryRaw<{ patient_id: string; status: string }[]>`
      SELECT patient_id, status FROM visit WHERE id = ${args.visitId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!v[0]) throw new NotFoundError("Visit not found.");
    if (!OPEN_VISIT.includes(v[0].status)) {
      throw new ValidationError("This visit is signed or closed. Record a new acuity on the chart.");
    }
    // One per visit: a change during the visit corrects it.
    await tx.$executeRaw`
      INSERT INTO patient_acuity_event (org_id, patient_id, acuity, source, visit_id, recorded_by_user_id)
      VALUES (${args.orgId}::uuid, ${v[0].patient_id}::uuid, ${args.acuity}, 'visit', ${args.visitId}::uuid, ${args.userId}::uuid)
      ON CONFLICT (visit_id) WHERE visit_id IS NOT NULL
      DO UPDATE SET acuity = EXCLUDED.acuity, recorded_by_user_id = EXCLUDED.recorded_by_user_id, recorded_at = now()
    `;
    // The NP's is the patient's current acuity.
    await tx.$executeRaw`
      UPDATE patient SET acuity = ${args.acuity}, acuity_updated_at = now(),
                         acuity_updated_by_user_id = ${args.userId}::uuid, updated_at = now()
       WHERE id = ${v[0].patient_id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "acuity_change", targetType: "visit", targetId: args.visitId,
      payload: { source: "visit", acuity: args.acuity, patientId: v[0].patient_id },
    });
  });
}

// ---------------------------------------------------------------------------
// Hospice eligibility
// ---------------------------------------------------------------------------

export async function addHospiceAssessment(args: {
  orgId: string; userId: string; patientId: string; payload: HospiceAssessment;
}): Promise<{ id: string }> {
  const h = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    await patientRow(tx, args.orgId, args.patientId);
    notAfter(h.assessedOn, await practiceToday(tx, args.orgId), "The assessment");
    if (h.visitId) {
      const v = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM visit WHERE id = ${h.visitId}::uuid AND org_id = ${args.orgId}::uuid AND patient_id = ${args.patientId}::uuid
      `;
      if (!v[0]) throw new ValidationError("That visit is not this patient's.");
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO hospice_eligibility_assessment (org_id, patient_id, eligible, assessed_on, basis, visit_id, assessed_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${h.eligible}, ${h.assessedOn}::date,
              ${h.basis?.trim() || null}, ${h.visitId ?? null}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "hospice_assessment", targetType: "patient", targetId: args.patientId,
      payload: { assessmentId: rows[0]!.id, eligible: h.eligible },
    });
    return { id: rows[0]!.id };
  });
}

// ---------------------------------------------------------------------------
// Significant events
// ---------------------------------------------------------------------------

export async function addEvent(args: {
  orgId: string; userId: string; patientId: string; payload: AddEvent;
}): Promise<{ id: string }> {
  const e = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    await patientRow(tx, args.orgId, args.patientId);
    const today = await practiceToday(tx, args.orgId);
    notAfter(e.occurredOn, today, "The event");
    notAfter(e.endedOn, today, "The discharge");
    if (e.visitId) {
      const v = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM visit WHERE id = ${e.visitId}::uuid AND org_id = ${args.orgId}::uuid AND patient_id = ${args.patientId}::uuid
      `;
      if (!v[0]) throw new ValidationError("That visit is not this patient's.");
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_event (org_id, patient_id, kind, occurred_on, ended_on, facility, injury, description,
                                 visit_id, recorded_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${e.kind}, ${e.occurredOn}::date, ${e.endedOn ?? null}::date,
              ${e.facility?.trim() || null}, ${e.injury ?? null}::boolean, ${e.description?.trim() || null},
              ${e.visitId ?? null}::uuid, ${args.userId}::uuid)
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "patient_event_change", targetType: "patient", targetId: args.patientId,
      payload: { op: "add", kind: e.kind, eventId: rows[0]!.id },
    });
    // A fall, ED visit or admission the NP asked to hear of (0116, doc:55-56).
    await raiseForEvent(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId, eventId: rows[0]!.id, kind: e.kind,
    });
    return { id: rows[0]!.id };
  });
}

export async function updateEvent(args: {
  orgId: string; userId: string; patientId: string; eventId: string; payload: UpdateEvent;
}): Promise<{ updated: true }> {
  const u = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ kind: string; occurred_on: string; voided_at: Date | null }[]>`
      SELECT kind, to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, voided_at FROM patient_event
       WHERE id = ${args.eventId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Event not found.");
    if (cur[0].voided_at) throw new ValidationError("This event was voided as recorded in error.");
    if ("void" in u) {
      await tx.$executeRaw`
        UPDATE patient_event SET voided_at = now(), voided_by_user_id = ${args.userId}::uuid, void_reason = ${u.void.reason}
         WHERE id = ${args.eventId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      await writeAudit(tx, {
        orgId: args.orgId, userId: args.userId, action: "patient_event_change", targetType: "patient", targetId: args.patientId,
        payload: { op: "void", kind: cur[0].kind, eventId: args.eventId },
      });
      await withdrawForSource(tx, {
        orgId: args.orgId, userId: args.userId, patientId: args.patientId, source: { kind: "event", eventId: args.eventId },
      });
      return { updated: true };
    }
    if (u.endedOn !== undefined && u.endedOn !== null) {
      if (cur[0].kind !== "hospital_admission") throw new ValidationError("Only an admission has a discharge day.");
      if (u.endedOn < cur[0].occurred_on) throw new ValidationError("Discharged before admitted.");
      notAfter(u.endedOn, await practiceToday(tx, args.orgId), "The discharge");
    }
    if (u.injury !== undefined && u.injury !== null && cur[0].kind !== "fall") {
      throw new ValidationError("Only a fall has an injury.");
    }
    const sent = (v: unknown) => v !== undefined;
    await tx.$executeRaw`
      UPDATE patient_event SET
        ended_on    = CASE WHEN ${sent(u.endedOn)} THEN ${u.endedOn ?? null}::date ELSE ended_on END,
        facility    = CASE WHEN ${sent(u.facility)} THEN ${u.facility?.trim() || null} ELSE facility END,
        injury      = CASE WHEN ${sent(u.injury)} THEN ${u.injury ?? null}::boolean ELSE injury END,
        description = CASE WHEN ${sent(u.description)} THEN ${u.description?.trim() || null} ELSE description END
      WHERE id = ${args.eventId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "patient_event_change", targetType: "patient", targetId: args.patientId,
      payload: { op: "edit", kind: cur[0].kind, eventId: args.eventId, fields: Object.keys(u).filter((k) => sent(u[k as keyof typeof u])) },
    });
    return { updated: true };
  });
}

// ---------------------------------------------------------------------------
// Discharge, the hospice stay, readmission
// ---------------------------------------------------------------------------

export async function dischargePatient(args: {
  orgId: string; userId: string; patientId: string; payload: Discharge;
}): Promise<{ id: string; status: "discharged" | "deceased" }> {
  const d = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const p = await patientRow(tx, args.orgId, args.patientId);
    if (p.status !== "active") throw new ValidationError("Only a patient under care can be discharged.");
    const today = await practiceToday(tx, args.orgId);
    notAfter(d.dischargedOn, today, "The discharge");
    if (p.admitted_on && d.dischargedOn < p.admitted_on) {
      throw new ValidationError(`Care began on ${p.admitted_on}; the discharge cannot be earlier.`);
    }
    const code = await tx.$queryRaw<{ code: string; category: string }[]>`
      SELECT code, category FROM org_reason_code
       WHERE id = ${d.reasonCodeId}::uuid AND org_id = ${args.orgId}::uuid AND kind = 'discharge' AND active
    `;
    if (!code[0]) throw new ValidationError("Pick one of the practice's discharge reasons.");
    const hospice = isHospiceCategory(code[0].category);
    const death = code[0].category === "death";
    if (!hospice && (d.hospiceName || d.hospiceAdmittedOn)) {
      throw new ValidationError("A hospice and its admission day go with a discharge to hospice.");
    }
    if (d.hospiceAdmittedOn) notAfter(d.hospiceAdmittedOn, today, "The hospice admission");
    if (!death && d.diedOn) throw new ValidationError("A death is recorded with a death discharge code.");
    const diedOn = death ? (d.diedOn ?? d.dischargedOn) : null;
    if (diedOn) notAfter(diedOn, today, "The death");

    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patient_discharge (org_id, patient_id, admitted_on, discharged_on, reason_code_id, note,
                                     hospice_name, hospice_admitted_on, died_on, recorded_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${p.admitted_on}::date, ${d.dischargedOn}::date,
              ${d.reasonCodeId}::uuid, ${d.note?.trim() || null}, ${hospice ? d.hospiceName?.trim() || null : null},
              ${hospice ? (d.hospiceAdmittedOn ?? null) : null}::date, ${diedOn}::date, ${args.userId}::uuid)
      RETURNING id
    `;
    const status = death ? "deceased" : "discharged";
    // discharged_at, which nothing wrote (23 Sep brief, defect 4).
    await tx.$executeRaw`
      UPDATE patient SET status = ${status}, discharged_at = now(), updated_at = now()
       WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    // A PCM/CCM enrolment ends with the episode (0116). A readmission does not
    // restart it: consent is asked for again.
    const endedEnrollments = await tx.$executeRaw`
      UPDATE care_program_enrollment
         SET ended_on = GREATEST(${d.dischargedOn}::date, enrolled_on), end_reason = 'Discharged',
             ended_by_user_id = ${args.userId}::uuid
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND ended_on IS NULL
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "patient_discharge", targetType: "patient", targetId: args.patientId,
      payload: {
        op: "discharge", dischargeId: rows[0]!.id, reasonCode: code[0].code, category: code[0].category, status,
        endedEnrollments,
      },
    });
    return { id: rows[0]!.id, status };
  });
}

/**
 * The hospice stay, as it becomes known: the hospice and its admission day,
 * then how the stay ended. Each part keeps what is stored unless sent.
 */
export async function recordHospiceStay(args: {
  orgId: string; userId: string; patientId: string; payload: HospiceStay;
}): Promise<{ updated: true }> {
  const s = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    // The patient first, then the discharge: the order a readmission takes.
    await patientRow(tx, args.orgId, args.patientId);
    const cur = await tx.$queryRaw<
      { id: string; category: string; hospice_admitted_on: string | null; hospice_ended_on: string | null }[]
    >`
      SELECT d.id, rc.category, to_char(d.hospice_admitted_on, 'YYYY-MM-DD') AS hospice_admitted_on,
             to_char(d.hospice_ended_on, 'YYYY-MM-DD') AS hospice_ended_on
        FROM patient_discharge d
        JOIN org_reason_code rc ON rc.id = d.reason_code_id AND rc.org_id = d.org_id
       WHERE d.patient_id = ${args.patientId}::uuid AND d.org_id = ${args.orgId}::uuid AND d.reversed_at IS NULL
       FOR UPDATE OF d
    `;
    if (!cur[0] || !isHospiceCategory(cur[0].category)) {
      throw new ValidationError("This patient was not discharged to hospice.");
    }
    const today = await practiceToday(tx, args.orgId);
    const admitted = s.hospiceAdmittedOn ?? cur[0].hospice_admitted_on;
    const ended = s.hospiceEndedOn ?? cur[0].hospice_ended_on;
    notAfter(s.hospiceAdmittedOn, today, "The hospice admission");
    notAfter(s.hospiceEndedOn, today, "The end of the hospice stay");
    if (ended && !admitted) throw new ValidationError("Say when the hospice admitted the patient.");
    if (ended && admitted && ended < admitted) throw new ValidationError("The hospice stay ended before it began.");
    // A discharge to hospice has a death day only from how the stay ended, so
    // a correction of the ending corrects the death and the status with it.
    const ending = s.hospiceEndReason !== undefined;
    const died = s.hospiceEndReason === "death";
    await tx.$executeRaw`
      UPDATE patient_discharge SET
        hospice_name        = CASE WHEN ${s.hospiceName !== undefined} THEN ${s.hospiceName?.trim() || null} ELSE hospice_name END,
        hospice_admitted_on = COALESCE(${s.hospiceAdmittedOn ?? null}::date, hospice_admitted_on),
        hospice_ended_on    = COALESCE(${s.hospiceEndedOn ?? null}::date, hospice_ended_on),
        hospice_end_reason  = COALESCE(${s.hospiceEndReason ?? null}, hospice_end_reason),
        died_on             = CASE WHEN ${ending} THEN ${died ? (s.hospiceEndedOn ?? null) : null}::date ELSE died_on END,
        updated_at = now()
      WHERE id = ${cur[0].id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (ending) {
      await tx.$executeRaw`
        UPDATE patient SET status = ${died ? "deceased" : "discharged"}, updated_at = now()
         WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
           AND status IN ('discharged', 'deceased')
      `;
    }
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "patient_discharge", targetType: "patient", targetId: args.patientId,
      payload: ending
        ? { op: "hospice_outcome", dischargeId: cur[0].id, endReason: s.hospiceEndReason }
        : { op: "hospice_details", dischargeId: cur[0].id, fields: Object.keys(s).filter((k) => s[k as keyof HospiceStay] !== undefined) },
    });
    return { updated: true };
  });
}

/** Back under care: the discharge in force is kept, marked, and a new episode begins. */
export async function readmitPatient(args: {
  orgId: string; userId: string; patientId: string; payload: Readmit;
}): Promise<{ updated: true }> {
  const r = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const p = await patientRow(tx, args.orgId, args.patientId);
    if (p.status !== "discharged" && p.status !== "deceased") {
      throw new ValidationError("This patient is not discharged.");
    }
    const cur = await tx.$queryRaw<{ id: string; discharged_on: string }[]>`
      SELECT id, to_char(discharged_on, 'YYYY-MM-DD') AS discharged_on FROM patient_discharge
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND reversed_at IS NULL
       FOR UPDATE
    `;
    notAfter(r.readmittedOn, await practiceToday(tx, args.orgId), "The readmission");
    if (cur[0] && r.readmittedOn < cur[0].discharged_on) {
      throw new ValidationError(`The discharge was on ${cur[0].discharged_on}; the readmission cannot be earlier.`);
    }
    if (cur[0]) {
      await tx.$executeRaw`
        UPDATE patient_discharge SET reversed_at = now(), reversed_by_user_id = ${args.userId}::uuid,
               reversed_reason = ${r.reason}, updated_at = now()
         WHERE id = ${cur[0].id}::uuid AND org_id = ${args.orgId}::uuid
      `;
    }
    await tx.$executeRaw`
      UPDATE patient SET status = 'active', discharged_at = NULL, admitted_on = ${r.readmittedOn}::date, updated_at = now()
       WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "patient_discharge", targetType: "patient", targetId: args.patientId,
      payload: { op: "readmit", dischargeId: cur[0]?.id ?? null },
    });
    return { updated: true };
  });
}
