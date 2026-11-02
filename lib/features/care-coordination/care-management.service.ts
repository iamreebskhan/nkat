/**
 * PCM/CCM time and the month's charge (0117; Level-1 doc:53, :69, :101; Mark
 * Q10 default: "a PCM/CCM time log with monthly totals. Clinical staff and NPs
 * can both log time, consent is a dated record, and the month's charge is
 * raised once the time qualifies").
 *
 *   logTime      a clinician's minutes on an enrolled patient's care, on a day
 *                the enrolment is in force: a practitioner's or clinical
 *                staff's by their credential on the Team page. A call counts
 *                its minutes through insertTimeEntry, in the call's own
 *                transaction (phone-encounter.service).
 *   voidTime     recorded in error: voided with the reason, never deleted.
 *   getMonth     one calendar month: the enrolments in force in it, their
 *                time, how far it has come under each code set, its charge.
 *   raiseCharge  the month's charge, by a practitioner. A signed visit on the
 *                reserved PCM/CCM month type carries the codes, diagnoses and
 *                date of service to the bill, which is then drafted as a
 *                signed visit's is: pricing, the claims queue, the 835.
 *
 * A charged month takes no more time, and none of its time can be voided: the
 * bill stands on it. Every write locks the enrolment row (NO KEY UPDATE, which
 * the time rows' foreign key does not wait on), so a charge and a time entry
 * for the same month never pass each other. Every statement names the org.
 * Audited with ids, the program, the activity, minutes and CPT codes; never a
 * note.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import { autoDraftSuperbill } from "@/lib/features/superbills/auto-draft";
import { tierForCredential } from "@/lib/features/team/clinician";

import { CARE_PROGRAM_SHORT, type CareProgram } from "./care-coordination.types";
import {
  CARE_MANAGEMENT_VISIT_TYPE,
  MIN_DIAGNOSES,
  chargeFor,
  chargeSummaryText,
  monthBounds,
  monthLabel,
  monthOf,
  monthProgress,
  performerKindFor,
  type CareManagementMonthView,
  type ChargeBasis,
  type ChargeView,
  type CmActivity,
  type LogTime,
  type PerformerKind,
  type RaiseCharge,
  type TimeEntry,
  type TimeEntryView,
} from "./care-management";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

interface EnrollmentRow {
  id: string;
  program: CareProgram;
  enrolled_on: string;
  ended_on: string | null;
  consent_on: string;
  consent_method: "verbal" | "written";
}

/** The patient's enrolment, locked for the write that follows. */
async function lockEnrollment(tx: Tx, orgId: string, patientId: string, enrollmentId: string): Promise<EnrollmentRow> {
  const rows = await tx.$queryRaw<EnrollmentRow[]>`
    SELECT id, program, to_char(enrolled_on, 'YYYY-MM-DD') AS enrolled_on,
           to_char(ended_on, 'YYYY-MM-DD') AS ended_on, to_char(consent_on, 'YYYY-MM-DD') AS consent_on,
           consent_method
      FROM care_program_enrollment
     WHERE id = ${enrollmentId}::uuid AND patient_id = ${patientId}::uuid AND org_id = ${orgId}::uuid
     FOR NO KEY UPDATE
  `;
  if (!rows[0]) throw new NotFoundError("Enrolment not found.");
  return rows[0];
}

async function credentialOf(tx: Tx, orgId: string, userId: string): Promise<string | null> {
  const r = await tx.$queryRaw<{ credential: string | null }[]>`
    SELECT credential FROM clinician_profile WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
  `;
  return r[0]?.credential ?? null;
}

async function chargeOf(tx: Tx, orgId: string, enrollmentId: string, month: string): Promise<{ raised_on: string } | null> {
  const r = await tx.$queryRaw<{ raised_on: string }[]>`
    SELECT to_char((c.raised_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS raised_on
      FROM care_management_charge c
      JOIN org o ON o.id = c.org_id
     WHERE c.enrollment_id = ${enrollmentId}::uuid AND c.org_id = ${orgId}::uuid
       AND c.month = ${`${month}-01`}::date
  `;
  return r[0] ?? null;
}

/**
 * One entry of time, after every check an entry passes: the enrolment in
 * force on the day, the day not after today, its month not charged, and a
 * clinician's credential to say whose time it is. The caller's transaction:
 * logTime's own, or the call's whose minutes these are.
 */
export async function insertTimeEntry(
  tx: Tx,
  a: {
    orgId: string;
    userId: string;
    patientId: string;
    enrollmentId: string;
    serviceOn: string;
    minutes: number;
    activity: CmActivity;
    note?: string | null;
    phoneEncounterId?: string | null;
  },
): Promise<{ id: string; program: CareProgram; kind: PerformerKind }> {
  const e = await lockEnrollment(tx, a.orgId, a.patientId, a.enrollmentId);
  const program = CARE_PROGRAM_SHORT[e.program];
  const today = orgToday(await readOrgTimeZone(tx, a.orgId));
  if (a.serviceOn > today) throw new ValidationError("The day is after today.");
  if (a.serviceOn < e.enrolled_on) {
    throw new ValidationError(`Enrolled in ${program} on ${e.enrolled_on}: time before that day is not counted under it.`);
  }
  if (e.ended_on && a.serviceOn > e.ended_on) {
    throw new ValidationError(`The ${program} enrolment ended on ${e.ended_on}.`);
  }
  const month = monthOf(a.serviceOn);
  const charged = await chargeOf(tx, a.orgId, a.enrollmentId, month);
  if (charged) {
    throw new ValidationError(
      `${monthLabel(month)} is already charged for ${program} (raised on ${charged.raised_on}), so it takes no more time.`,
    );
  }
  const credential = await credentialOf(tx, a.orgId, a.userId);
  if (!credential) {
    throw new ValidationError(
      "Your credential isn't recorded on the Team page. PCM/CCM time is a clinician's: an admin adds the credential, then the time can be logged.",
    );
  }
  const kind = performerKindFor(credential);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO care_management_time (org_id, patient_id, enrollment_id, performed_by_user_id, performer_kind,
                                      service_on, minutes, activity, note, phone_encounter_id)
    VALUES (${a.orgId}::uuid, ${a.patientId}::uuid, ${a.enrollmentId}::uuid, ${a.userId}::uuid, ${kind},
            ${a.serviceOn}::date, ${a.minutes}::smallint, ${a.activity}, ${a.note?.trim() || null},
            ${a.phoneEncounterId ?? null}::uuid)
    RETURNING id
  `;
  const id = rows[0]!.id;
  await writeAudit(tx, {
    orgId: a.orgId,
    userId: a.userId,
    action: "care_management_time",
    targetType: "patient",
    targetId: a.patientId,
    payload: {
      op: "log",
      entryId: id,
      enrollmentId: a.enrollmentId,
      program: e.program,
      kind,
      minutes: a.minutes,
      activity: a.activity,
      fromCall: Boolean(a.phoneEncounterId),
    },
  });
  return { id, program: e.program, kind };
}

export async function logTime(args: { orgId: string; userId: string; patientId: string; payload: LogTime }): Promise<{ id: string }> {
  const t = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const r = await insertTimeEntry(tx, {
      orgId: args.orgId, userId: args.userId, patientId: args.patientId, enrollmentId: t.enrollmentId,
      serviceOn: t.serviceOn, minutes: t.minutes, activity: t.activity, note: t.note ?? null,
    });
    return { id: r.id };
  });
}

/**
 * Void time recorded in error, with the reason. Refused once its month is
 * charged. The time a call counted is voided with the call (voidCallTime).
 */
export async function voidTime(args: {
  orgId: string; userId: string; patientId: string; entryId: string; reason: string;
}): Promise<{ updated: true }> {
  return withOrgContext(args.orgId, async (tx) => {
    const found = await tx.$queryRaw<{ enrollment_id: string }[]>`
      SELECT enrollment_id FROM care_management_time
       WHERE id = ${args.entryId}::uuid AND patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!found[0]) throw new NotFoundError("Time entry not found.");
    // The enrolment first, as every write here takes it, then the entry.
    const e = await lockEnrollment(tx, args.orgId, args.patientId, found[0].enrollment_id);
    const cur = await tx.$queryRaw<{ service_on: string; voided_at: Date | null; phone_encounter_id: string | null }[]>`
      SELECT to_char(service_on, 'YYYY-MM-DD') AS service_on, voided_at, phone_encounter_id
        FROM care_management_time
       WHERE id = ${args.entryId}::uuid AND org_id = ${args.orgId}::uuid
       FOR UPDATE
    `;
    if (cur[0]!.voided_at) throw new ValidationError("This time was already voided.");
    await refuseIfCharged(tx, args.orgId, e, cur[0]!.service_on);
    await tx.$executeRaw`
      UPDATE care_management_time
         SET voided_at = now(), voided_by_user_id = ${args.userId}::uuid, void_reason = ${args.reason.trim()}
       WHERE id = ${args.entryId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "care_management_time", targetType: "patient",
      targetId: args.patientId,
      payload: { op: "void", entryId: args.entryId, enrollmentId: e.id, program: e.program, fromCall: Boolean(cur[0]!.phone_encounter_id) },
    });
    return { updated: true };
  });
}

async function refuseIfCharged(tx: Tx, orgId: string, e: EnrollmentRow, serviceOn: string): Promise<void> {
  const month = monthOf(serviceOn);
  const charged = await chargeOf(tx, orgId, e.id, month);
  if (charged) {
    throw new ValidationError(
      `${monthLabel(month)}'s ${CARE_PROGRAM_SHORT[e.program]} charge (raised on ${charged.raised_on}) is billed on this time, so it stands. A correction goes through billing.`,
    );
  }
}

/**
 * The time a call counted, voided with the call, in the call's transaction.
 * Refused, and the call with it, when that month is charged.
 */
export async function voidCallTime(
  tx: Tx,
  a: { orgId: string; userId: string; patientId: string; phoneEncounterId: string; reason: string },
): Promise<void> {
  const found = await tx.$queryRaw<{ id: string; enrollment_id: string }[]>`
    SELECT id, enrollment_id FROM care_management_time
     WHERE phone_encounter_id = ${a.phoneEncounterId}::uuid AND org_id = ${a.orgId}::uuid AND voided_at IS NULL
  `;
  if (!found[0]) return;
  const e = await lockEnrollment(tx, a.orgId, a.patientId, found[0].enrollment_id);
  const cur = await tx.$queryRaw<{ service_on: string; voided_at: Date | null }[]>`
    SELECT to_char(service_on, 'YYYY-MM-DD') AS service_on, voided_at
      FROM care_management_time
     WHERE id = ${found[0].id}::uuid AND org_id = ${a.orgId}::uuid
     FOR UPDATE
  `;
  if (cur[0]!.voided_at) return;
  await refuseIfCharged(tx, a.orgId, e, cur[0]!.service_on);
  await tx.$executeRaw`
    UPDATE care_management_time
       SET voided_at = now(), voided_by_user_id = ${a.userId}::uuid, void_reason = ${a.reason.trim()}
     WHERE id = ${found[0].id}::uuid AND org_id = ${a.orgId}::uuid
  `;
  await writeAudit(tx, {
    orgId: a.orgId, userId: a.userId, action: "care_management_time", targetType: "patient", targetId: a.patientId,
    payload: { op: "void", entryId: found[0].id, enrollmentId: e.id, program: e.program, fromCall: true },
  });
}

interface TimeRow {
  id: string;
  enrollment_id: string;
  service_on: string;
  minutes: number;
  activity: CmActivity;
  note: string | null;
  performed_by_user_id: string;
  performed_by_name: string | null;
  performer_kind: PerformerKind;
  phone_encounter_id: string | null;
  voided_at: Date | null;
  void_reason: string | null;
}

async function monthEntries(tx: Tx, orgId: string, enrollmentIds: string[], first: string, last: string): Promise<TimeRow[]> {
  if (enrollmentIds.length === 0) return [];
  return tx.$queryRaw<TimeRow[]>`
    SELECT t.id, t.enrollment_id, to_char(t.service_on, 'YYYY-MM-DD') AS service_on, t.minutes, t.activity, t.note,
           t.performed_by_user_id, COALESCE(u.full_name, u.email) AS performed_by_name, t.performer_kind,
           t.phone_encounter_id, t.voided_at, t.void_reason
      FROM care_management_time t
      LEFT JOIN app_user u ON u.id = t.performed_by_user_id
     WHERE t.org_id = ${orgId}::uuid
       AND t.enrollment_id = ANY(${enrollmentIds}::uuid[])
       AND t.service_on BETWEEN ${first}::date AND ${last}::date
     ORDER BY t.service_on, t.created_at
  `;
}

/** Not voided, and on a day the enrolment was in force (a discharge can end it after the time was logged). */
const counts = (t: TimeRow, e: EnrollmentRow) =>
  t.voided_at === null && t.service_on >= e.enrolled_on && (e.ended_on === null || t.service_on <= e.ended_on);

const asEntry = (t: TimeRow): TimeEntry => ({
  serviceOn: t.service_on, minutes: t.minutes, kind: t.performer_kind, performedBy: t.performed_by_user_id,
});

/** One month of the patient's PCM/CCM; without one, the practice's current month. */
export async function getMonth(args: {
  orgId: string; patientId: string; month?: string | null; viewerUserId: string;
}): Promise<CareManagementMonthView> {
  return withOrgContext(args.orgId, async (tx) => {
    const p = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!p[0]) throw new NotFoundError("Patient not found.");
    const today = orgToday(await readOrgTimeZone(tx, args.orgId));
    const month = args.month ?? monthOf(today);
    const { first, last } = monthBounds(month);
    const enrollments = await tx.$queryRaw<EnrollmentRow[]>`
      SELECT id, program, to_char(enrolled_on, 'YYYY-MM-DD') AS enrolled_on,
             to_char(ended_on, 'YYYY-MM-DD') AS ended_on, to_char(consent_on, 'YYYY-MM-DD') AS consent_on,
             consent_method
        FROM care_program_enrollment
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
         AND enrolled_on <= ${last}::date AND (ended_on IS NULL OR ended_on >= ${first}::date)
       ORDER BY program, enrolled_on
    `;
    const ids = enrollments.map((e) => e.id);
    const entries = await monthEntries(tx, args.orgId, ids, first, last);
    const charges =
      ids.length === 0
        ? []
        : await tx.$queryRaw<
            {
              id: string; enrollment_id: string; visit_id: string; basis: ChargeBasis; date_of_service: string;
              codes: string[]; units: Record<string, number> | null; qhp_minutes: number; staff_minutes: number;
              raised_by_name: string | null; raised_at: Date; superbill_id: string | null; superbill_status: string | null;
            }[]
          >`
            SELECT c.id, c.enrollment_id, c.visit_id, c.basis, to_char(c.date_of_service, 'YYYY-MM-DD') AS date_of_service,
                   c.codes, c.units, c.qhp_minutes, c.staff_minutes, COALESCE(u.full_name, u.email) AS raised_by_name,
                   c.raised_at, s.id AS superbill_id, s.status AS superbill_status
              FROM care_management_charge c
              LEFT JOIN app_user u ON u.id = c.raised_by_user_id
              LEFT JOIN superbill s ON s.visit_id = c.visit_id AND s.org_id = c.org_id
             WHERE c.org_id = ${args.orgId}::uuid AND c.enrollment_id = ANY(${ids}::uuid[])
               AND c.month = ${first}::date
          `;
    const viewerCredential = await credentialOf(tx, args.orgId, args.viewerUserId);
    const viewerKind = viewerCredential ? performerKindFor(viewerCredential) : null;
    const problems = await tx.$queryRaw<{ icd10: string; description: string }[]>`
      SELECT icd10, description FROM patient_problem
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND status = 'active'
       ORDER BY recorded_at, icd10
    `;
    const plan = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM care_plan WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;

    return {
      today,
      month,
      viewer: { kind: viewerKind },
      hasCarePlan: Boolean(plan[0]),
      problems,
      programs: enrollments.map((e) => {
        const mine = entries.filter((t) => t.enrollment_id === e.id);
        const counted = mine.filter((t) => counts(t, e));
        const progress = monthProgress(e.program, counted.map(asEntry), viewerKind === "qhp" ? args.viewerUserId : null);
        const c = charges.find((x) => x.enrollment_id === e.id);
        const charge: ChargeView | null = c
          ? {
              id: c.id, visitId: c.visit_id, basis: c.basis, dateOfService: c.date_of_service, codes: c.codes,
              units: c.units ?? {}, qhpMinutes: c.qhp_minutes, staffMinutes: c.staff_minutes,
              raisedByName: c.raised_by_name, raisedAt: c.raised_at.toISOString(), superbillId: c.superbill_id,
              superbillStatus: c.superbill_status,
            }
          : null;
        return {
          enrollmentId: e.id,
          program: e.program,
          enrolledOn: e.enrolled_on,
          endedOn: e.ended_on,
          consentOn: e.consent_on,
          consentMethod: e.consent_method,
          entries: mine.map(
            (t): TimeEntryView => ({
              id: t.id, serviceOn: t.service_on, minutes: t.minutes, activity: t.activity, note: t.note,
              performedByUserId: t.performed_by_user_id, performedByName: t.performed_by_name, kind: t.performer_kind,
              phoneEncounterId: t.phone_encounter_id, voidedAt: t.voided_at?.toISOString() ?? null,
              voidReason: t.void_reason, counted: counts(t, e),
            }),
          ),
          minutes: {
            staff: counted.filter((t) => t.performer_kind === "clinical_staff").reduce((n, t) => n + t.minutes, 0),
            qhp: counted.filter((t) => t.performer_kind === "qhp").reduce((n, t) => n + t.minutes, 0),
          },
          staff: progress.staff,
          qhp: progress.qhp,
          charge,
        };
      }),
    };
  });
}

/**
 * Raise a month's charge (visits.submit, by a practitioner). Refused unless the
 * month's time reaches the chosen set's base code, the diagnoses come from the
 * active problem list (PCM one, CCM two or more), and a care plan exists. The
 * draft bill follows outside the transaction, as on sign-off: best-effort, and
 * its outcome is returned.
 */
export async function raiseCharge(args: {
  orgId: string; userId: string; patientId: string; payload: RaiseCharge;
}): Promise<{ chargeId: string; visitId: string; superbillId: string | null; autoDraftError: string | null }> {
  const r = args.payload;
  const raised = await withOrgContext(args.orgId, async (tx) => {
    const e = await lockEnrollment(tx, args.orgId, args.patientId, r.enrollmentId);
    const program = CARE_PROGRAM_SHORT[e.program];
    const label = monthLabel(r.month);
    const zone = await readOrgTimeZone(tx, args.orgId);
    const today = orgToday(zone);
    if (r.month > monthOf(today)) throw new ValidationError(`${label} hasn't started.`);
    const { first, last } = monthBounds(r.month);
    if (e.enrolled_on > last || (e.ended_on !== null && e.ended_on < first)) {
      throw new ValidationError(`The ${program} enrolment was not in force in ${label}.`);
    }
    const already = await chargeOf(tx, args.orgId, e.id, r.month);
    if (already) throw new ValidationError(`${label} is already charged for ${program} (raised on ${already.raised_on}).`);

    const credential = await credentialOf(tx, args.orgId, args.userId);
    if (!tierForCredential(credential)) {
      throw new ValidationError(
        `A PCM/CCM month is billed by a practitioner — an NP, MD, DO, PA or CNS. ${credential ? `Your credential on the Team page is ${credential}.` : "Your credential isn't recorded on the Team page."}`,
      );
    }
    const plan = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM care_plan WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!plan[0]) throw new ValidationError(`${program} is billed against the patient's care plan. Write the care plan first.`);

    // The diagnoses: from the active problem list, in the order given.
    const problems = await tx.$queryRaw<{ icd10: string }[]>`
      SELECT icd10 FROM patient_problem
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND status = 'active'
    `;
    const active = new Set(problems.map((x) => x.icd10.toUpperCase()));
    const diagnoses = r.diagnoses.map((d) => d.trim().toUpperCase());
    const stray = diagnoses.filter((d) => !active.has(d));
    if (stray.length > 0) {
      throw new ValidationError(`Not on the active problem list: ${stray.join(", ")}. A charge's diagnoses come from the problem list.`);
    }
    if (diagnoses.length < MIN_DIAGNOSES[e.program]) {
      throw new ValidationError(
        e.program === "ccm"
          ? "CCM is billed for two or more chronic conditions: pick at least two diagnoses."
          : "PCM is billed for the serious condition it manages: pick its diagnosis.",
      );
    }

    const rows = (await monthEntries(tx, args.orgId, [e.id], first, last)).filter((t) => counts(t, e));
    const progress = monthProgress(e.program, rows.map(asEntry), args.userId);
    const p = r.basis === "staff" ? progress.staff : progress.qhp!;
    const most = p.reached.length - 1;
    if (most < 0) {
      throw new ValidationError(
        r.basis === "staff"
          ? `${label}'s ${program} time is ${p.minutes} minutes; ${p.base} needs ${p.first}.`
          : `Your own ${program} time in ${label} is ${p.minutes} minutes; ${p.base} needs ${p.first} of the practitioner's own time.`,
      );
    }
    if (r.addOnUnits !== undefined && r.addOnUnits > most) {
      throw new ValidationError(
        most === 0
          ? `The time supports ${p.base} alone, with no add-on unit.`
          : `The time supports at most ${most} unit${most === 1 ? "" : "s"} of ${p.addOn}.`,
      );
    }
    const c = chargeFor(p, r.addOnUnits)!;
    const used = r.basis === "staff" ? rows : rows.filter((t) => t.performer_kind === "qhp" && t.performed_by_user_id === args.userId);
    const qhpMinutes = used.filter((t) => t.performer_kind === "qhp").reduce((n, t) => n + t.minutes, 0);
    const staffMinutes = used.filter((t) => t.performer_kind === "clinical_staff").reduce((n, t) => n + t.minutes, 0);

    // The reserved type the month is carried on: created by the first charge,
    // inactive so it is never offered for booking, never listed or edited.
    await tx.$executeRaw`
      INSERT INTO org_visit_type (org_id, slug, label, coding_basis, active, sort_order, is_telehealth)
      VALUES (${args.orgId}::uuid, ${CARE_MANAGEMENT_VISIT_TYPE}, 'PCM/CCM month', 'care_management', false, 0, false)
      ON CONFLICT (org_id, lower(slug)) DO NOTHING
    `;
    const type = await tx.$queryRaw<{ coding_basis: string }[]>`
      SELECT coding_basis FROM org_visit_type
       WHERE org_id = ${args.orgId}::uuid AND lower(slug) = ${CARE_MANAGEMENT_VISIT_TYPE}
    `;
    if (type[0]?.coding_basis !== "care_management") {
      throw new Error("The PCM/CCM month visit type is taken by another type in this practice.");
    }

    const who = await tx.$queryRaw<{ name: string | null }[]>`
      SELECT COALESCE(full_name, email) AS name FROM app_user WHERE id = ${args.userId}::uuid
    `;
    const raisedBy = `${who[0]?.name ?? "the practitioner"}, ${credential}`;
    const summary = chargeSummaryText({
      program: e.program, month: r.month, basis: r.basis, codes: c.codes, units: c.units,
      minutes: { counted: p.minutes, staff: staffMinutes, qhp: qhpMinutes }, entries: used.length,
      firstDay: used[0]!.service_on, lastDay: used.at(-1)!.service_on, dateOfService: c.dateOfService,
      enrolledOn: e.enrolled_on, consentOn: e.consent_on, consentMethod: e.consent_method, raisedBy,
    });

    // A signed visit, as sign-off leaves one and submitted for billing: noon of
    // the date of service where the practice is, so the bill's day is that day.
    const visit = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO visit (org_id, patient_id, clinician_user_id, visit_type,
                         start_time, stop_time, total_minutes, is_telehealth,
                         document_text, cpt_codes_assigned, cpt_units, icd10_codes, modifiers,
                         status, signed_at, signed_by_user_id, signer_credential, place_of_service_code)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${args.userId}::uuid, ${CARE_MANAGEMENT_VISIT_TYPE},
              (${c.dateOfService}::date + time '12:00') AT TIME ZONE ${zone},
              (${c.dateOfService}::date + time '12:00') AT TIME ZONE ${zone},
              ${p.minutes}::int, false,
              ${summary}, ${c.codes}::text[], ${JSON.stringify(c.units)}::jsonb, ${diagnoses}::text[], ARRAY[]::text[],
              'pending_billing', now(), ${args.userId}::uuid, ${credential}, ${r.placeOfService})
      RETURNING id
    `;
    const visitId = visit[0]!.id;
    const charge = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO care_management_charge (org_id, patient_id, enrollment_id, month, visit_id, basis, date_of_service,
                                          codes, units, qhp_minutes, staff_minutes, raised_by_user_id)
      VALUES (${args.orgId}::uuid, ${args.patientId}::uuid, ${e.id}::uuid, ${first}::date, ${visitId}::uuid, ${r.basis},
              ${c.dateOfService}::date, ${c.codes}::text[], ${JSON.stringify(c.units)}::jsonb, ${qhpMinutes}::int,
              ${staffMinutes}::int, ${args.userId}::uuid)
      RETURNING id
    `;
    const chargeId = charge[0]!.id;
    await writeAudit(tx, {
      orgId: args.orgId, userId: args.userId, action: "care_management_charge", targetType: "patient",
      targetId: args.patientId,
      payload: {
        op: "raise", chargeId, visitId, enrollmentId: e.id, program: e.program, basis: r.basis,
        cptCodes: c.codes, addOnUnits: c.addOnUnits, minutes: p.minutes, diagnosisCount: diagnoses.length,
      },
    });
    return { chargeId, visitId };
  });

  // The bill, as sign-off drafts one (transition route): outside the
  // transaction, best-effort, and said when it could not be drafted.
  const draft = await autoDraftSuperbill({ orgId: args.orgId, visitId: raised.visitId, actorUserId: args.userId });
  return { ...raised, superbillId: draft.superbillId, autoDraftError: draft.reason };
}
