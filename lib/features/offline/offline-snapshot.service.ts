/**
 * The copy a clinician takes offline (0119; doc:33; Mark Q8 default): the
 * patients whose care team they are on (the caseload's clinical seats), and
 * their own visits from yesterday to a week ahead with each note as it stands,
 * so it can be written with no signal and sent on reconnect.
 *
 * Read in a few statements for the whole caseload rather than a chart at a
 * time (an NP's caseload runs to 70), and each statement names the org. The
 * notes are read through getVisitNote, the editor's own read, so a section and
 * its version are exactly what the note route would answer. The copy is a
 * disclosure of PHI to the device and is logged as one, with every patient in
 * it.
 */
import { withOrgContext } from "@/lib/db";
import { medicationLabel } from "@/lib/features/clinical/clinical-lists.types";
import {
  EscalationRuleSchema,
  escalationRuleText,
  type Intervention,
  type MonitoringItem,
} from "@/lib/features/care-plans/care-plan.types";
import { addDaysIso, orgLocalMinute, orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import { getVisitNote } from "@/lib/features/visits/note.service";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";
import { ethnicityText, languageText, raceText } from "@/lib/features/patients/uscdi";
import { logPhiExport } from "@/lib/hipaa/phi-access-log";

import {
  OFFLINE_VISIT_DAYS,
  OFFLINE_VITALS_KEYS,
  listText,
  proseText,
  type OfflinePatient,
  type OfflineSnapshot,
  type OfflineVisit,
} from "./offline";

const SEAT_LABEL = { primary_np: "Primary NP", rn: "RN", social_worker: "Social worker", chaplain: "Chaplain" } as const;

export async function getOfflineSnapshot(args: { orgId: string; userId: string; now?: Date }): Promise<OfflineSnapshot> {
  const org = args.orgId;
  const base = await withOrgContext(org, async (tx) => {
    const tz = await readOrgTimeZone(tx, org);
    const today = orgToday(tz, args.now);
    const from = addDaysIso(today, -OFFLINE_VISIT_DAYS.back);
    const to = addDaysIso(today, OFFLINE_VISIT_DAYS.ahead);
    const me = await tx.$queryRaw<{ name: string | null }[]>`
      SELECT COALESCE(full_name, email) AS name FROM app_user WHERE id = ${args.userId}::uuid
    `;

    // My visits still to be written, in the window, then my care-team patients.
    const visits = await tx.$queryRaw<
      { id: string; patient_id: string; patient_name: string; type: string | null; at: Date | null; status: string }[]
    >`
      SELECT v.id, v.patient_id, TRIM(p.first_name || ' ' || p.last_name) AS patient_name,
             COALESCE(t.label, v.visit_type) AS type, COALESCE(v.start_time, v.scheduled_start) AS at, v.status
        FROM visit v
        JOIN org o ON o.id = v.org_id
        JOIN patient p ON p.id = v.patient_id AND p.org_id = v.org_id
        LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
       WHERE v.org_id = ${org}::uuid
         AND v.clinician_user_id = ${args.userId}::uuid
         AND (v.status = 'scheduled' OR v.status = 'in_progress')
         AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
         AND p.status <> 'archived'
         AND (COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date BETWEEN ${from}::date AND ${to}::date
       ORDER BY COALESCE(v.start_time, v.scheduled_start)
    `;

    const patients = await tx.$queryRaw<
      {
        id: string; name: string; date_of_birth: string | null; sex: string | null; phone: string | null;
        address_line_1: string | null; address_line_2: string | null; city: string | null; state: string | null; zip: string | null;
        acuity: string | null; dx_code: string | null; dx_description: string | null; referral_reason: string | null;
        payer_name: string | null; no_known_allergies: boolean;
        np_name: string | null; rn_name: string | null; sw_name: string | null; ch_name: string | null;
        race_codes: string[] | null; ethnicity_code: string | null; preferred_language: string | null;
      }[]
    >`
      SELECT p.id, TRIM(p.first_name || ' ' || p.last_name) AS name,
             to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.sex_assigned_at_birth AS sex, p.phone,
             p.address_line_1, p.address_line_2, p.city, p.state, p.zip, p.acuity,
             p.primary_diagnosis_icd10 AS dx_code,
             (SELECT i.description FROM icd10 i
               WHERE replace(upper(i.code), '.', '') = replace(upper(p.primary_diagnosis_icd10), '.', '')
               LIMIT 1) AS dx_description,
             p.palliative_referral_reason AS referral_reason, pay.name AS payer_name,
             p.no_known_allergies_at IS NOT NULL AS no_known_allergies,
             p.race_codes, p.ethnicity_code, p.preferred_language,
             COALESCE(np.full_name, np.email) AS np_name, COALESCE(rn.full_name, rn.email) AS rn_name,
             COALESCE(sw.full_name, sw.email) AS sw_name, COALESCE(ch.full_name, ch.email) AS ch_name
        FROM patient p
        LEFT JOIN payer pay ON pay.id = p.primary_payer_id
        LEFT JOIN app_user np ON np.id = p.primary_np_user_id
        LEFT JOIN app_user rn ON rn.id = p.rn_user_id
        LEFT JOIN app_user sw ON sw.id = p.social_worker_user_id
        LEFT JOIN app_user ch ON ch.id = p.chaplain_user_id
       WHERE p.org_id = ${org}::uuid
         AND p.status <> 'archived'
         AND ((p.status = 'active'
               AND ${args.userId}::uuid IN (p.primary_np_user_id, p.rn_user_id, p.social_worker_user_id, p.chaplain_user_id))
              OR p.id = ANY(${visits.map((v) => v.patient_id)}::uuid[]))
       ORDER BY p.last_name, p.first_name
    `;
    const ids = patients.map((p) => p.id);

    const contacts = await tx.$queryRaw<
      { patient_id: string; full_name: string; relationship: string | null; phone: string | null;
        caregiver: boolean; emergency: boolean; poa: boolean }[]
    >`
      SELECT patient_id, full_name, relationship, phone, is_primary_caregiver AS caregiver,
             is_emergency_contact AS emergency, is_healthcare_poa AS poa
        FROM patient_contact
       WHERE org_id = ${org}::uuid AND patient_id = ANY(${ids}::uuid[])
       ORDER BY is_primary_caregiver DESC, is_emergency_contact DESC, full_name
    `;
    const problems = await tx.$queryRaw<{ patient_id: string; icd10: string; description: string }[]>`
      SELECT patient_id, icd10, description FROM patient_problem
       WHERE org_id = ${org}::uuid AND patient_id = ANY(${ids}::uuid[]) AND status = 'active'
       ORDER BY recorded_at
    `;
    const meds = await tx.$queryRaw<
      { patient_id: string; name: string; dose: string | null; route: string | null; frequency: string | null; prn: boolean }[]
    >`
      SELECT patient_id, name, dose, route, frequency, prn FROM patient_medication
       WHERE org_id = ${org}::uuid AND patient_id = ANY(${ids}::uuid[]) AND status = 'active'
       ORDER BY name
    `;
    const allergies = await tx.$queryRaw<{ patient_id: string; substance: string; reaction: string | null; severity: string | null }[]>`
      SELECT patient_id, substance, reaction, severity FROM patient_allergy
       WHERE org_id = ${org}::uuid AND patient_id = ANY(${ids}::uuid[]) AND status = 'active'
       ORDER BY substance
    `;
    const plans = await tx.$queryRaw<
      { patient_id: string; goals: string[] | null; symptoms: string[] | null; interventions: Intervention[] | null;
        monitoring: MonitoringItem[] | null; escalation: unknown; review_on: string | null }[]
    >`
      SELECT patient_id, goals, primary_symptoms AS symptoms, interventions, monitoring, escalation,
             to_char(review_on, 'YYYY-MM-DD') AS review_on
        FROM care_plan
       WHERE org_id = ${org}::uuid AND patient_id = ANY(${ids}::uuid[])
    `;
    // The last three visits made for each, with what was assessed and planned.
    const recent = await tx.$queryRaw<
      { patient_id: string; day: string; type: string | null; clinician: string | null; ap: unknown }[]
    >`
      SELECT r.patient_id, r.day, r.type, r.clinician, s.content AS ap
        FROM (
          SELECT v.id, v.patient_id, COALESCE(t.label, v.visit_type) AS type, COALESCE(u.full_name, u.email) AS clinician,
                 to_char((COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS day,
                 row_number() OVER (PARTITION BY v.patient_id ORDER BY COALESCE(v.start_time, v.scheduled_start) DESC) AS n
            FROM visit v
            JOIN org o ON o.id = v.org_id
            LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
            LEFT JOIN app_user u ON u.id = v.clinician_user_id
           WHERE v.org_id = ${org}::uuid AND v.patient_id = ANY(${ids}::uuid[])
             AND (v.status = 'documented' OR v.status = 'pending_billing' OR v.status = 'billed')
             AND v.visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
        ) r
        LEFT JOIN visit_note_section s ON s.visit_id = r.id AND s.org_id = ${org}::uuid AND s.section_key = 'assessment_and_plan'
       WHERE r.n <= 3
       ORDER BY r.patient_id, r.day DESC
    `;

    const by = <T extends { patient_id: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r.patient_id, [...(m.get(r.patient_id) ?? []), r]);
      return m;
    };
    const [cBy, pBy, mBy, aBy, rBy] = [by(contacts), by(problems), by(meds), by(allergies), by(recent)];
    const planBy = new Map(plans.map((p) => [p.patient_id, p]));

    const offlinePatients: OfflinePatient[] = patients.map((p) => {
      const plan = planBy.get(p.id);
      return {
        id: p.id,
        name: p.name,
        dateOfBirth: p.date_of_birth,
        sex: p.sex,
        race: raceText(p.race_codes),
        ethnicity: ethnicityText(p.ethnicity_code),
        preferredLanguage: languageText(p.preferred_language),
        phone: p.phone,
        address: [p.address_line_1, p.address_line_2, [p.city, p.state, p.zip].filter(Boolean).join(" ")].filter((x) => x && x.trim()).join(", ") || null,
        acuity: p.acuity,
        primaryDiagnosis: p.dx_code ? `${p.dx_code}${p.dx_description ? ` ${p.dx_description}` : ""}` : null,
        referralReason: p.referral_reason,
        payerName: p.payer_name,
        careTeam: [
          ...(p.np_name ? [{ role: SEAT_LABEL.primary_np, name: p.np_name }] : []),
          ...(p.rn_name ? [{ role: SEAT_LABEL.rn, name: p.rn_name }] : []),
          ...(p.sw_name ? [{ role: SEAT_LABEL.social_worker, name: p.sw_name }] : []),
          ...(p.ch_name ? [{ role: SEAT_LABEL.chaplain, name: p.ch_name }] : []),
        ],
        contacts: (cBy.get(p.id) ?? []).map((c) => ({
          name: c.full_name,
          relationship: c.relationship,
          phone: c.phone,
          roles: [c.caregiver && "Primary caregiver", c.emergency && "Emergency contact", c.poa && "Healthcare POA"].filter((x): x is string => Boolean(x)),
        })),
        problems: (pBy.get(p.id) ?? []).map((x) => ({ code: x.icd10, description: x.description })),
        medications: (mBy.get(p.id) ?? []).map(medicationLabel),
        allergies: (aBy.get(p.id) ?? []).map((a) => ({ substance: a.substance, reaction: a.reaction, severity: a.severity })),
        noKnownAllergies: p.no_known_allergies,
        carePlan: plan
          ? {
              goals: plan.goals ?? [],
              symptoms: plan.symptoms ?? [],
              interventions: (plan.interventions ?? []).map((i) => i.item),
              monitoring: (plan.monitoring ?? []).map((m) => `${m.item}${m.everyDays ? `, every ${m.everyDays} days` : ""}`),
              // Stored rules that no longer parse are skipped, as crossedRules does.
              escalation: (Array.isArray(plan.escalation) ? plan.escalation : []).flatMap((r) => {
                const parsed = EscalationRuleSchema.safeParse(r);
                return parsed.success ? [escalationRuleText(parsed.data)] : [];
              }),
              reviewOn: plan.review_on,
            }
          : null,
        recentVisits: (rBy.get(p.id) ?? []).map((r) => ({ day: r.day, type: r.type ?? "Visit", clinician: r.clinician, assessmentAndPlan: proseText(r.ap) })),
      };
    });

    return {
      tz,
      today,
      userName: me[0]?.name ?? "",
      patients: offlinePatients,
      visits: visits.map((v) => ({ ...v, when: v.at ? orgLocalMinute(v.at, tz) : "Not scheduled" })),
    };
  });

  // Each note through the editor's own read: its template version's sections
  // and each one's version, the vitals and when they were recorded.
  const visits: OfflineVisit[] = [];
  for (const v of base.visits) {
    const note = await getVisitNote({ orgId: org, visitId: v.id });
    visits.push({
      id: v.id,
      patientId: v.patient_id,
      patientName: v.patient_name,
      type: v.type ?? "Visit",
      when: v.when,
      status: v.status,
      sections: note.sections
        .filter((s) => s.kind !== "vitals")
        .map((s) => ({
          sectionKey: s.sectionKey,
          label: s.label,
          helpText: s.helpText,
          kind: s.kind,
          isRequired: s.isRequired,
          text: s.kind === "list" ? listText(s.content) : proseText(s.content),
          updatedAt: s.updatedAt,
        })),
      vitals: note.sections.some((s) => s.kind === "vitals")
        ? {
            values: {
              ...Object.fromEntries(OFFLINE_VITALS_KEYS.map((k) => [k, note.vitals?.[k] ?? null])),
              notes: note.vitals?.notes ?? null,
            },
            recordedAt: note.vitals?.recordedAt ?? null,
          }
        : null,
    });
  }

  const snapshot: OfflineSnapshot = {
    version: 1,
    generatedAt: (args.now ?? new Date()).toISOString(),
    orgId: org,
    user: { id: args.userId, name: base.userName },
    practiceToday: base.today,
    patients: base.patients,
    visits,
  };
  // A disclosure to the device, with every patient in it (0119).
  void logPhiExport({
    orgId: org,
    userId: args.userId,
    exportType: "offline_snapshot",
    patientIds: base.patients.map((p) => p.id),
    byteSize: Buffer.byteLength(JSON.stringify(snapshot)),
  });
  return snapshot;
}
