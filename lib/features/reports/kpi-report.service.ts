/**
 * The KPI report's rows (Level-1 doc:80-109), read for a window of the
 * practice's days and handed to buildKpiReport (kpi-report.ts), which holds
 * every definition.
 *
 * Each statement names the org as well as relying on RLS, as every report
 * does. Archived charts are left out of the patient and visit measures (they
 * are out of every list); their bills stay in the money, which was billed and
 * paid all the same. A PCM/CCM month (0117) carries a bill and is never a
 * visit made. History before the window is read where a measure needs it:
 * every spell of care for the census, each patient's first symptom score,
 * the acuity recorded before, and earlier hospital admissions for the 30-day
 * readmission tag.
 */
import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";

import { applyKpiHistory } from "./kpi-history";
import { readEnteredMonths, readReasons } from "./kpi-history.service";
import { buildKpiReport, type CareProgram, type KpiReport } from "./kpi-report";
import { buildYearOverYear, priorYearRange, type KpiYearOverYear } from "./kpi-year-over-year";
import { presetRange, rangeProblem } from "./report-range";

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Days before the window read for the readmission tag: the 30-day window, and any admission long enough to end in it. */
const ADMISSION_LOOKBACK_DAYS = 400;

export async function getKpiReport(args: {
  orgId: string;
  fromDay?: string;
  toDay?: string;
  /** For tests; the practice's today is taken from it. */
  now?: Date;
}): Promise<KpiReport> {
  return withOrgContext(args.orgId, async (tx) => {
    const org = args.orgId;
    const tz = await readOrgTimeZone(tx, org);
    const today = orgToday(tz, args.now);
    // Twelve calendar months to today unless asked: the Trend Report's span.
    const fallback = presetRange("12m", today);
    const range = { fromDate: args.fromDay ?? fallback.fromDate, toDate: args.toDay ?? today };
    const problem = rangeProblem(range);
    if (problem) throw new ValidationError(problem);
    const from = range.fromDate;
    const to = range.toDate;

    const referrals = await tx.$queryRaw<
      { received_on: string; stage: string; source_name: string | null; ntuc_on: string | null; ntuc_code: string | null; ntuc_label: string | null; first_visit_on: string | null }[]
    >`
      WITH r AS (
        SELECT r.received_on, r.stage, r.source_name, r.ntuc_on, rc.code AS ntuc_code, rc.label AS ntuc_label,
               -- The admitted patient's first visit made, on or after the day
               -- the referral came in (doc:98).
               (SELECT min((COALESCE(v.start_time, v.scheduled_start, v.created_at) AT TIME ZONE o.timezone)::date)
                  FROM visit v
                 WHERE v.org_id = r.org_id AND v.patient_id = r.patient_id
                   AND v.status <> 'scheduled' AND v.status <> 'cancelled' AND v.status <> 'no_show'
                   AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
                   AND (COALESCE(v.start_time, v.scheduled_start, v.created_at) AT TIME ZONE o.timezone)::date >= r.received_on
               ) AS first_visit_on
          FROM referral r
          JOIN org o ON o.id = r.org_id
          LEFT JOIN org_reason_code rc ON rc.id = r.ntuc_reason_code_id AND rc.org_id = r.org_id
          LEFT JOIN patient p ON p.id = r.patient_id AND p.org_id = r.org_id
         WHERE r.org_id = ${org}::uuid
           AND r.received_on <= ${to}::date
           AND (p.id IS NULL OR p.status <> 'archived')
      )
      SELECT to_char(received_on, 'YYYY-MM-DD') AS received_on, stage, source_name, to_char(ntuc_on, 'YYYY-MM-DD') AS ntuc_on,
             ntuc_code, ntuc_label, to_char(first_visit_on, 'YYYY-MM-DD') AS first_visit_on
        FROM r
       WHERE received_on >= ${from}::date
          OR ntuc_on BETWEEN ${from}::date AND ${to}::date
          OR first_visit_on BETWEEN ${from}::date AND ${to}::date
    `;

    // Every spell of care, whenever: the census on a past day needs them all.
    const episodes = await tx.$queryRaw<{ patient_id: string; from_day: string; to_day: string | null }[]>`
      SELECT d.patient_id,
             to_char(COALESCE(d.admitted_on, (p.created_at AT TIME ZONE o.timezone)::date), 'YYYY-MM-DD') AS from_day,
             to_char(d.discharged_on, 'YYYY-MM-DD') AS to_day
        FROM patient_discharge d
        JOIN patient p ON p.id = d.patient_id AND p.org_id = d.org_id
        JOIN org o ON o.id = d.org_id
       WHERE d.org_id = ${org}::uuid AND p.status <> 'archived'
      UNION ALL
      -- Under care now: the spell begun on the day admitted (a readmission's).
      SELECT p.id, to_char(COALESCE(p.admitted_on, (p.created_at AT TIME ZONE o.timezone)::date), 'YYYY-MM-DD'), NULL
        FROM patient p
        JOIN org o ON o.id = p.org_id
       WHERE p.org_id = ${org}::uuid AND p.status = 'active'
      UNION ALL
      -- Discharged before discharges carried a day and a reason (0115): the
      -- status, and the day discharged_at gives.
      SELECT p.id, to_char(COALESCE(p.admitted_on, (p.created_at AT TIME ZONE o.timezone)::date), 'YYYY-MM-DD'),
             to_char((p.discharged_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD')
        FROM patient p
        JOIN org o ON o.id = p.org_id
       WHERE p.org_id = ${org}::uuid AND (p.status = 'discharged' OR p.status = 'deceased')
         AND p.discharged_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM patient_discharge d WHERE d.patient_id = p.id AND d.org_id = p.org_id)
    `;

    const visits = await tx.$queryRaw<
      { patient_id: string; clinician_user_id: string; clinician_name: string | null; day: string; coding_basis: string | null; cpt_codes_assigned: string[] | null }[]
    >`
      SELECT v.patient_id, v.clinician_user_id, COALESCE(u.full_name, u.email) AS clinician_name,
             to_char((COALESCE(v.start_time, v.scheduled_start, v.created_at) AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS day,
             t.coding_basis, v.cpt_codes_assigned
        FROM visit v
        JOIN org o ON o.id = v.org_id
        JOIN patient p ON p.id = v.patient_id AND p.org_id = v.org_id
        LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
        LEFT JOIN app_user u ON u.id = v.clinician_user_id
       WHERE v.org_id = ${org}::uuid
         AND v.status <> 'scheduled' AND v.status <> 'cancelled' AND v.status <> 'no_show'
         AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
         AND p.status <> 'archived'
         AND (COALESCE(v.start_time, v.scheduled_start, v.created_at) AT TIME ZONE o.timezone)::date
             BETWEEN ${from}::date AND ${to}::date
    `;

    const discharges = await tx.$queryRaw<
      { discharged_on: string; code: string | null; label: string | null; category: string | null; hospice_admitted_on: string | null; hospice_ended_on: string | null }[]
    >`
      SELECT to_char(d.discharged_on, 'YYYY-MM-DD') AS discharged_on, rc.code, rc.label, rc.category,
             to_char(d.hospice_admitted_on, 'YYYY-MM-DD') AS hospice_admitted_on,
             to_char(d.hospice_ended_on, 'YYYY-MM-DD') AS hospice_ended_on
        FROM patient_discharge d
        JOIN patient p ON p.id = d.patient_id AND p.org_id = d.org_id
        LEFT JOIN org_reason_code rc ON rc.id = d.reason_code_id AND rc.org_id = d.org_id
       WHERE d.org_id = ${org}::uuid AND p.status <> 'archived'
         AND (d.discharged_on BETWEEN ${from}::date AND ${to}::date
              OR d.hospice_admitted_on BETWEEN ${from}::date AND ${to}::date
              OR d.hospice_ended_on BETWEEN ${from}::date AND ${to}::date)
      UNION ALL
      SELECT to_char((p.discharged_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD'), NULL, NULL, NULL, NULL, NULL
        FROM patient p
        JOIN org o ON o.id = p.org_id
       WHERE p.org_id = ${org}::uuid AND (p.status = 'discharged' OR p.status = 'deceased')
         AND p.discharged_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM patient_discharge d WHERE d.patient_id = p.id AND d.org_id = p.org_id)
         AND (p.discharged_at AT TIME ZONE o.timezone)::date BETWEEN ${from}::date AND ${to}::date
    `;

    const events = await tx.$queryRaw<
      { id: string; patient_id: string; kind: string; occurred_on: string; ended_on: string | null; injury: boolean | null }[]
    >`
      SELECT e.id, e.patient_id, e.kind, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
             to_char(e.ended_on, 'YYYY-MM-DD') AS ended_on, e.injury
        FROM patient_event e
        JOIN patient p ON p.id = e.patient_id AND p.org_id = e.org_id
       WHERE e.org_id = ${org}::uuid AND e.voided_at IS NULL AND p.status <> 'archived'
         AND e.occurred_on BETWEEN ${from}::date - ${ADMISSION_LOOKBACK_DAYS}::int AND ${to}::date
    `;

    const assessments = await tx.$queryRaw<{ patient_id: string; assessed_on: string; eligible: boolean }[]>`
      SELECT a.patient_id, to_char(a.assessed_on, 'YYYY-MM-DD') AS assessed_on, a.eligible
        FROM hospice_eligibility_assessment a
        JOIN patient p ON p.id = a.patient_id AND p.org_id = a.org_id
       WHERE a.org_id = ${org}::uuid AND p.status <> 'archived'
         AND a.assessed_on BETWEEN ${from}::date AND ${to}::date
    `;

    // Each scored patient's scores up to the window's end, so their first one
    // is there to compare with (doc:83).
    const scores = await tx.$queryRaw<
      { patient_id: string; day: string; at: Date; pain_score: number | null; dyspnea_score: number | null; nausea_score: number | null }[]
    >`
      WITH s AS (
        SELECT vv.patient_id,
               (COALESCE(v.start_time, v.scheduled_start, vv.recorded_at) AT TIME ZONE o.timezone)::date AS day,
               COALESCE(v.start_time, vv.recorded_at) AS at,
               vv.pain_score, vv.dyspnea_score, vv.nausea_score
          FROM visit_vitals vv
          JOIN visit v ON v.id = vv.visit_id AND v.org_id = vv.org_id
          JOIN org o ON o.id = vv.org_id
         WHERE vv.org_id = ${org}::uuid
           AND v.status <> 'cancelled' AND v.status <> 'no_show'
           AND (vv.pain_score IS NOT NULL OR vv.dyspnea_score IS NOT NULL OR vv.nausea_score IS NOT NULL)
        UNION ALL
        SELECT c.patient_id, (c.occurred_at AT TIME ZONE o.timezone)::date, c.occurred_at,
               c.pain_score, c.dyspnea_score, c.nausea_score
          FROM phone_encounter c
          JOIN org o ON o.id = c.org_id
         WHERE c.org_id = ${org}::uuid AND c.voided_at IS NULL
           AND (c.pain_score IS NOT NULL OR c.dyspnea_score IS NOT NULL OR c.nausea_score IS NOT NULL)
      )
      SELECT s.patient_id, to_char(s.day, 'YYYY-MM-DD') AS day, s.at, s.pain_score, s.dyspnea_score, s.nausea_score
        FROM s
        JOIN patient p ON p.id = s.patient_id AND p.org_id = ${org}::uuid
       WHERE p.status <> 'archived'
         AND s.day <= ${to}::date
         AND s.patient_id IN (SELECT patient_id FROM s WHERE day BETWEEN ${from}::date AND ${to}::date)
    `;

    const acuity = await tx.$queryRaw<{ patient_id: string; day: string; at: Date; acuity: string }[]>`
      SELECT a.patient_id, to_char((a.recorded_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS day,
             a.recorded_at AS at, a.acuity
        FROM patient_acuity_event a
        JOIN patient p ON p.id = a.patient_id AND p.org_id = a.org_id
        JOIN org o ON o.id = a.org_id
       WHERE a.org_id = ${org}::uuid AND p.status <> 'archived'
         AND (a.recorded_at AT TIME ZONE o.timezone)::date <= ${to}::date
    `;

    const enrollments = await tx.$queryRaw<{ patient_id: string; program: CareProgram; enrolled_on: string; ended_on: string | null }[]>`
      SELECT e.patient_id, e.program, to_char(e.enrolled_on, 'YYYY-MM-DD') AS enrolled_on,
             to_char(e.ended_on, 'YYYY-MM-DD') AS ended_on
        FROM care_program_enrollment e
        JOIN patient p ON p.id = e.patient_id AND p.org_id = e.org_id
       WHERE e.org_id = ${org}::uuid AND p.status <> 'archived'
         AND e.enrolled_on <= ${to}::date
         AND (e.ended_on IS NULL OR e.ended_on >= ${from}::date)
    `;

    const careTime = await tx.$queryRaw<{ program: CareProgram; service_on: string; minutes: number }[]>`
      SELECT e.program, to_char(t.service_on, 'YYYY-MM-DD') AS service_on, t.minutes
        FROM care_management_time t
        JOIN care_program_enrollment e ON e.id = t.enrollment_id AND e.org_id = t.org_id
        JOIN patient p ON p.id = t.patient_id AND p.org_id = t.org_id
       WHERE t.org_id = ${org}::uuid AND t.voided_at IS NULL AND p.status <> 'archived'
         AND t.service_on BETWEEN ${from}::date AND ${to}::date
    `;

    const careCharges = await tx.$queryRaw<{ program: CareProgram; month: string }[]>`
      SELECT e.program, to_char(c.month, 'YYYY-MM') AS month
        FROM care_management_charge c
        JOIN care_program_enrollment e ON e.id = c.enrollment_id AND e.org_id = c.org_id
        JOIN patient p ON p.id = c.patient_id AND p.org_id = c.org_id
       WHERE c.org_id = ${org}::uuid AND p.status <> 'archived'
         AND c.month BETWEEN date_trunc('month', ${from}::date)::date AND ${to}::date
    `;

    const bills = await tx.$queryRaw<
      {
        patient_id: string; clinician_user_id: string | null; clinician_name: string | null; status: string; dos: string;
        billed_amount_cents: bigint | number; paid_amount_cents: bigint | number | null; submitted_on: string | null;
      }[]
    >`
      SELECT s.patient_id, v.clinician_user_id, COALESCE(u.full_name, u.email, s.provider_name) AS clinician_name,
             s.status, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos,
             s.billed_amount_cents, s.paid_amount_cents,
             to_char((s.submitted_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS submitted_on
        FROM superbill s
        JOIN org o ON o.id = s.org_id
        LEFT JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
        LEFT JOIN app_user u ON u.id = v.clinician_user_id
       WHERE s.org_id = ${org}::uuid
         AND (s.date_of_service BETWEEN ${from}::date AND ${to}::date
              OR (s.submitted_at AT TIME ZONE o.timezone)::date BETWEEN ${from}::date AND ${to}::date)
    `;

    // On the claims' own date of service, as the denial rate is everywhere (R29).
    const denials = await tx.$queryRaw<{ payer_name: string | null; dos: string; denied_amount_cents: bigint | number }[]>`
      SELECT pay.name AS payer_name, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos, d.denied_amount_cents
        FROM superbill_denial d
        JOIN superbill s ON s.id = d.superbill_id AND s.org_id = d.org_id
        LEFT JOIN payer pay ON pay.id = d.payer_id
       WHERE d.org_id = ${org}::uuid
         AND s.date_of_service BETWEEN ${from}::date AND ${to}::date
    `;

    const report = buildKpiReport({
      range,
      today,
      referrals: referrals.map((r) => ({
        receivedOn: r.received_on,
        stage: r.stage,
        source: r.source_name,
        ntucOn: r.ntuc_on,
        ntucReason: r.ntuc_code ? { code: r.ntuc_code, label: r.ntuc_label ?? "" } : null,
        firstVisitOn: r.first_visit_on,
      })),
      episodes: episodes.map((e) => ({ patientId: e.patient_id, from: e.from_day, to: e.to_day })),
      visits: visits.map((v) => ({
        patientId: v.patient_id,
        clinicianId: v.clinician_user_id,
        clinicianName: v.clinician_name,
        day: v.day,
        codingBasis: v.coding_basis,
        cptCodes: v.cpt_codes_assigned ?? [],
      })),
      discharges: discharges.map((d) => ({
        dischargedOn: d.discharged_on,
        reason: d.code ? { code: d.code, label: d.label ?? "", category: d.category ?? "other" } : null,
        hospiceAdmittedOn: d.hospice_admitted_on,
        hospiceEndedOn: d.hospice_ended_on,
      })),
      events: events.map((e) => ({
        id: e.id, patientId: e.patient_id, kind: e.kind, occurredOn: e.occurred_on, endedOn: e.ended_on, injury: e.injury,
      })),
      assessments: assessments.map((a) => ({ patientId: a.patient_id, assessedOn: a.assessed_on, eligible: a.eligible })),
      scores: scores.map((s) => ({
        patientId: s.patient_id, day: s.day, at: iso(s.at), pain: s.pain_score, dyspnea: s.dyspnea_score, nausea: s.nausea_score,
      })),
      acuity: acuity.map((a) => ({ patientId: a.patient_id, day: a.day, at: iso(a.at), acuity: a.acuity })),
      enrollments: enrollments.map((e) => ({ patientId: e.patient_id, program: e.program, enrolledOn: e.enrolled_on, endedOn: e.ended_on })),
      careTime: careTime.map((t) => ({ program: t.program, serviceOn: t.service_on, minutes: Number(t.minutes) })),
      careCharges: careCharges.map((c) => ({ program: c.program, month: c.month })),
      bills: bills.map((b) => ({
        patientId: b.patient_id,
        clinicianId: b.clinician_user_id,
        clinicianName: b.clinician_name,
        status: b.status,
        dos: b.dos,
        billedCents: Number(b.billed_amount_cents),
        paidCents: b.paid_amount_cents == null ? null : Number(b.paid_amount_cents),
        submittedOn: b.submitted_on,
      })),
      denials: denials.map((d) => ({ payerName: d.payer_name, dos: d.dos, deniedCents: Number(d.denied_amount_cents) })),
    });

    // The months a practice entered by hand stand for themselves (0125).
    const entered = await readEnteredMonths(tx, org, from, to);
    if (entered.length === 0) return report;
    return applyKpiHistory(report, entered, await readReasons(tx, org));
  });
}

/** The report, and the same days a year before beside it. */
export async function getKpiYearOverYear(args: {
  orgId: string;
  fromDay?: string;
  toDay?: string;
  now?: Date;
}): Promise<{ report: KpiReport; year: KpiYearOverYear }> {
  const report = await getKpiReport(args);
  const back = priorYearRange(report.range);
  const prior = await getKpiReport({ orgId: args.orgId, fromDay: back.fromDate, toDay: back.toDate, now: args.now });
  return { report, year: buildYearOverYear(report, prior) };
}
