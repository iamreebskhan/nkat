/**
 * Care plan service — one current row per patient, with a versioned
 * snapshot table for historical state.
 *
 * Source schema: db/migrations/0029_phase_pallio_emr.sql
 *   - `care_plan` — one row per patient, JSONB doc + symptoms/meds arrays
 *   - `care_plan_version` — append-only snapshots taken when a visit signs
 *
 * The TipTap document is stored as JSONB. Pallio renders it from the
 * editor; downstream consumers (PDF, eval) read just the structured
 * fields (`goalsOfCareSummary`, `primarySymptoms`, `activeMedications`).
 *
 * `activeMedications` is the chart's medication list (0114), read, never
 * kept here: a second list typed into the plan drifted from the chart's. A
 * version frozen at sign-off holds the chart's active medications as they
 * stood.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { medicationLabel } from "@/lib/features/clinical/clinical-lists.types";

import type { CarePlanStructure, EscalationRule, Intervention, MonitoringItem } from "./care-plan.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export interface CarePlanView {
  id: string;
  patientId: string;
  document: unknown; // TipTap JSON document
  goalsOfCareSummary: string | null;
  primarySymptoms: string[];
  activeMedications: string[];
  /** The formal plan's structured parts (0116, doc:38). */
  goals: string[];
  interventions: Intervention[];
  monitoring: MonitoringItem[];
  escalation: EscalationRule[];
  reviewOn: string | null;
  currentVersion: number;
  lastUpdatedVisitId: string | null;
  /**
   * The visit the plan was last changed during (doc:59): its day in the
   * practice's zone and its clinician, for "Updated during the visit of …".
   */
  lastUpdatedVisit: { id: string; day: string | null; clinicianName: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCarePlanArgs {
  orgId: string;
  patientId: string;
  document: unknown;
  goalsOfCareSummary?: string | null;
  primarySymptoms?: string[];
  /** The structured parts; each absent part keeps what is stored. */
  structure?: CarePlanStructure;
  /**
   * The visit this edit is made during (doc:59). Recorded as the plan's
   * last_updated_visit_id; the visit's sign-off freezes the plan with it.
   * Must be this patient's visit.
   */
  visitId?: string;
  /** When provided, also writes a snapshot row keyed to this visit. */
  snapshotForVisitId?: string;
  signedByUserId?: string;
}

/**
 * Upsert the patient's care plan. If a row exists, increment the
 * version. If `snapshotForVisitId` is set, also persist a frozen copy
 * to `care_plan_version` (versioning is on every visit-tied save).
 */
export async function upsertCarePlan(
  args: UpdateCarePlanArgs,
): Promise<{ id: string; version: number }> {
  return withOrgContext(args.orgId, async (tx) => {
    // Verify the patient exists FOR THIS TENANT first — RLS hides
    // cross-tenant patients, so this guards against creating an
    // orphan/cross-tenant care plan row. Named by org as well: on a
    // connection that bypasses RLS the id alone found another org's patient,
    // and the upsert below (one plan per patient) then wrote onto their plan.
    const patientExists = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patient WHERE id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid LIMIT 1
    `;
    if (patientExists.length === 0) throw new NotFoundError("Patient not found.");

    // An edit tied to a visit names one of this patient's own visits. Any
    // other id would put another patient's visit on this plan.
    const tiedVisitId = args.visitId ?? args.snapshotForVisitId ?? null;
    if (tiedVisitId) {
      const v = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM visit
         WHERE id = ${tiedVisitId}::uuid AND org_id = ${args.orgId}::uuid
           AND patient_id = ${args.patientId}::uuid
         LIMIT 1
      `;
      if (v.length === 0) throw new ValidationError("That visit is not this patient's.");
      // A signed visit froze the plan it was signed with; an edit made after
      // it is not that visit's.
      if (args.visitId && !["scheduled", "in_progress"].includes(v[0]!.status)) {
        throw new ValidationError(
          "That visit is signed or closed, and its care plan was frozen with it. Save the change without the visit.",
        );
      }
    }

    // The structured parts (0116): a part not sent keeps what is stored.
    const s = args.structure ?? {};
    const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
    const upsert = await tx.$queryRaw<
      { id: string; current_version: number }[]
    >`
      INSERT INTO care_plan (
        org_id, patient_id, document, goals_of_care_summary,
        primary_symptoms, last_updated_visit_id,
        goals, interventions, monitoring, escalation, review_on
      ) VALUES (
        ${args.orgId}::uuid, ${args.patientId}::uuid,
        ${JSON.stringify(args.document)}::jsonb,
        ${args.goalsOfCareSummary ?? null},
        ${args.primarySymptoms ?? null}::text[],
        ${tiedVisitId}::uuid,
        COALESCE(${s.goals ?? null}::text[], ARRAY[]::text[]),
        COALESCE(${json(s.interventions)}::jsonb, '[]'::jsonb),
        COALESCE(${json(s.monitoring)}::jsonb, '[]'::jsonb),
        COALESCE(${json(s.escalation)}::jsonb, '[]'::jsonb),
        ${s.reviewOn ?? null}::date
      )
      ON CONFLICT (patient_id) DO UPDATE SET
        document = EXCLUDED.document,
        -- Update semantics: absent/NULL = keep the stored value; '' (goals)
        -- or [] (arrays) = explicit clear. The care-plan editor PUTs only
        -- {document, goals}, so the previous unconditional overwrites wiped
        -- primary_symptoms/active_medications on every editor save, and the
        -- plain COALESCE on goals made an emptied textarea impossible to save.
        -- (active_medications is no longer written: the chart's list, 0114.)
        goals_of_care_summary = CASE
          WHEN EXCLUDED.goals_of_care_summary IS NULL THEN care_plan.goals_of_care_summary
          ELSE NULLIF(EXCLUDED.goals_of_care_summary, '')
        END,
        primary_symptoms = COALESCE(EXCLUDED.primary_symptoms, care_plan.primary_symptoms),
        goals = CASE WHEN ${s.goals !== undefined} THEN EXCLUDED.goals ELSE care_plan.goals END,
        interventions = CASE WHEN ${s.interventions !== undefined} THEN EXCLUDED.interventions ELSE care_plan.interventions END,
        monitoring = CASE WHEN ${s.monitoring !== undefined} THEN EXCLUDED.monitoring ELSE care_plan.monitoring END,
        escalation = CASE WHEN ${s.escalation !== undefined} THEN EXCLUDED.escalation ELSE care_plan.escalation END,
        review_on = CASE WHEN ${s.reviewOn !== undefined} THEN EXCLUDED.review_on ELSE care_plan.review_on END,
        -- The visit this edit was made during, or none: an edit outside a
        -- visit is not the last visit's, and keeping that visit would say it was.
        last_updated_visit_id = EXCLUDED.last_updated_visit_id,
        current_version = care_plan.current_version + 1,
        updated_at = now()
      RETURNING id, current_version
    `;
    const { id, current_version } = upsert[0]!;

    // Which parts were saved, never what they say (0116): the escalation
    // limits live here, and who set them must be answerable.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.signedByUserId ?? null,
      action: "care_plan_update",
      targetType: "patient",
      targetId: args.patientId,
      payload: {
        version: current_version,
        duringVisit: tiedVisitId !== null,
        parts: [
          "document",
          ...(args.goalsOfCareSummary !== undefined ? ["goalsOfCareSummary"] : []),
          ...(args.primarySymptoms !== undefined ? ["primarySymptoms"] : []),
          ...Object.keys(s).filter((k) => s[k as keyof CarePlanStructure] !== undefined),
        ],
      },
    });

    if (args.snapshotForVisitId) {
      // The whole plan as it now stands, not only the document (0110), with
      // the chart's active medications (0114; label as medicationLabel()).
      await tx.$executeRaw`
        INSERT INTO care_plan_version (
          org_id, care_plan_id, version, document, goals_of_care_summary,
          primary_symptoms, active_medications, snapshot_visit_id, created_by_user_id,
          goals, interventions, monitoring, escalation, review_on
        )
        SELECT cp.org_id, cp.id, cp.current_version, cp.document, cp.goals_of_care_summary,
               cp.primary_symptoms,
               ARRAY(SELECT concat_ws(' ', pm.name, NULLIF(btrim(pm.dose), ''), NULLIF(btrim(pm.route), ''),
                                      NULLIF(btrim(pm.frequency), ''))
                            || CASE WHEN pm.prn THEN ' PRN' ELSE '' END
                       FROM patient_medication pm
                      WHERE pm.patient_id = cp.patient_id AND pm.org_id = cp.org_id AND pm.status = 'active'
                      ORDER BY pm.recorded_at),
               ${args.snapshotForVisitId}::uuid, ${args.signedByUserId ?? null}::uuid,
               cp.goals, cp.interventions, cp.monitoring, cp.escalation, cp.review_on
          FROM care_plan cp
         WHERE cp.id = ${id}::uuid AND cp.org_id = ${args.orgId}::uuid
        ON CONFLICT (care_plan_id, version) DO NOTHING
      `;
    }

    return { id, version: current_version };
  });
}

/**
 * Freeze the patient's care plan as a visit is signed (doc:59), inside the
 * sign-off's own transaction: "what did the plan say when that visit was
 * signed?" Every signed visit gets its version, changed or not, so each one
 * answers for itself; the version number is what keeps them apart. A patient
 * with no care plan has nothing to freeze. Returns the frozen version.
 */
export async function freezeCarePlanForSignedVisit(
  tx: Tx,
  args: { orgId: string; visitId: string; signedByUserId: string | null },
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ version: number }[]>`
    WITH bumped AS (
      UPDATE care_plan cp
         SET current_version = cp.current_version + 1
        FROM visit v
       WHERE v.id = ${args.visitId}::uuid
         AND v.org_id = ${args.orgId}::uuid
         AND cp.patient_id = v.patient_id
         AND cp.org_id = v.org_id
      RETURNING cp.id, cp.org_id, cp.current_version, cp.document,
                cp.goals_of_care_summary, cp.primary_symptoms,
                cp.goals, cp.interventions, cp.monitoring, cp.escalation, cp.review_on,
                -- The chart's active medications as the visit is signed (0114),
                -- each as medicationLabel() writes it.
                ARRAY(SELECT concat_ws(' ', pm.name, NULLIF(btrim(pm.dose), ''), NULLIF(btrim(pm.route), ''),
                                       NULLIF(btrim(pm.frequency), ''))
                             || CASE WHEN pm.prn THEN ' PRN' ELSE '' END
                        FROM patient_medication pm
                       WHERE pm.patient_id = cp.patient_id AND pm.org_id = cp.org_id AND pm.status = 'active'
                       ORDER BY pm.recorded_at) AS active_medications
    )
    INSERT INTO care_plan_version (
      org_id, care_plan_id, version, document, goals_of_care_summary,
      primary_symptoms, active_medications, snapshot_visit_id, created_by_user_id,
      goals, interventions, monitoring, escalation, review_on
    )
    SELECT org_id, id, current_version, document, goals_of_care_summary,
           primary_symptoms, active_medications,
           ${args.visitId}::uuid, ${args.signedByUserId}::uuid,
           goals, interventions, monitoring, escalation, review_on
      FROM bumped
    RETURNING version
  `;
  return rows[0]?.version ?? null;
}

interface CarePlanRow {
  id: string;
  patient_id: string;
  document: unknown;
  goals_of_care_summary: string | null;
  primary_symptoms: string[] | null;
  goals: string[];
  interventions: Intervention[];
  monitoring: MonitoringItem[];
  escalation: EscalationRule[];
  review_on: string | null;
  current_version: number;
  last_updated_visit_id: string | null;
  last_visit_day: string | null;
  last_visit_clinician: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getCarePlan(args: {
  orgId: string;
  patientId: string;
}): Promise<CarePlanView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<CarePlanRow[]>`
      SELECT cp.id, cp.patient_id, cp.document, cp.goals_of_care_summary,
             cp.primary_symptoms, cp.current_version,
             cp.goals, cp.interventions, cp.monitoring, cp.escalation,
             to_char(cp.review_on, 'YYYY-MM-DD') AS review_on,
             cp.last_updated_visit_id,
             -- The visit's day where the practice is, as the visits list shows it.
             to_char((COALESCE(v.start_time, v.scheduled_start, v.created_at)
                       AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS last_visit_day,
             COALESCE(u.full_name, u.email) AS last_visit_clinician,
             cp.created_at, cp.updated_at
      FROM care_plan cp
      JOIN org o ON o.id = cp.org_id
      LEFT JOIN visit v ON v.id = cp.last_updated_visit_id AND v.org_id = cp.org_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      WHERE cp.patient_id = ${args.patientId}::uuid
        AND cp.org_id = ${args.orgId}::uuid
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    // The chart's medication list (0114), not the plan's old copy.
    const meds = await tx.$queryRaw<
      { name: string; dose: string | null; route: string | null; frequency: string | null; prn: boolean }[]
    >`
      SELECT name, dose, route, frequency, prn FROM patient_medication
       WHERE patient_id = ${args.patientId}::uuid AND org_id = ${args.orgId}::uuid AND status = 'active'
       ORDER BY recorded_at
    `;
    return {
      id: r.id,
      patientId: r.patient_id,
      document: r.document,
      goalsOfCareSummary: r.goals_of_care_summary,
      primarySymptoms: r.primary_symptoms ?? [],
      activeMedications: meds.map(medicationLabel),
      goals: r.goals ?? [],
      interventions: r.interventions ?? [],
      monitoring: r.monitoring ?? [],
      escalation: r.escalation ?? [],
      reviewOn: r.review_on,
      currentVersion: r.current_version,
      lastUpdatedVisitId: r.last_updated_visit_id,
      lastUpdatedVisit: r.last_updated_visit_id
        ? { id: r.last_updated_visit_id, day: r.last_visit_day, clinicianName: r.last_visit_clinician }
        : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  });
}

export interface CarePlanVersionView {
  version: number;
  document: unknown;
  /** The rest of the plan as frozen (0110); null on versions from before it. */
  goalsOfCareSummary: string | null;
  primarySymptoms: string[] | null;
  activeMedications: string[] | null;
  /** The structured parts as frozen (0116); null on versions from before them. */
  goals: string[] | null;
  interventions: Intervention[] | null;
  monitoring: MonitoringItem[] | null;
  escalation: EscalationRule[] | null;
  reviewOn: string | null;
  snapshotVisitId: string | null;
  /** The signed visit's day in the practice's zone. */
  snapshotVisitDay: string | null;
  /** Who froze it: the visit's signer. */
  createdByName: string | null;
  createdAt: string;
}

export async function listCarePlanVersions(args: {
  orgId: string;
  patientId: string;
  limit?: number;
}): Promise<CarePlanVersionView[]> {
  const limit = Math.min(50, args.limit ?? 20);
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        version: number;
        document: unknown;
        goals_of_care_summary: string | null;
        primary_symptoms: string[] | null;
        active_medications: string[] | null;
        goals: string[] | null;
        interventions: Intervention[] | null;
        monitoring: MonitoringItem[] | null;
        escalation: EscalationRule[] | null;
        review_on: string | null;
        snapshot_visit_id: string | null;
        snapshot_visit_day: string | null;
        created_by_name: string | null;
        created_at: Date;
      }[]
    >`
      SELECT v.version, v.document, v.goals_of_care_summary, v.primary_symptoms,
             v.active_medications, v.goals, v.interventions, v.monitoring, v.escalation,
             to_char(v.review_on, 'YYYY-MM-DD') AS review_on, v.snapshot_visit_id,
             to_char((COALESCE(sv.start_time, sv.scheduled_start, sv.created_at)
                       AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS snapshot_visit_day,
             COALESCE(u.full_name, u.email) AS created_by_name,
             v.created_at
      FROM care_plan_version v
      JOIN care_plan cp ON cp.id = v.care_plan_id AND cp.org_id = v.org_id
      JOIN org o ON o.id = cp.org_id
      LEFT JOIN visit sv ON sv.id = v.snapshot_visit_id AND sv.org_id = v.org_id
      LEFT JOIN app_user u ON u.id = v.created_by_user_id
      WHERE cp.patient_id = ${args.patientId}::uuid
        AND cp.org_id = ${args.orgId}::uuid
      ORDER BY v.version DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      version: r.version,
      document: r.document,
      goalsOfCareSummary: r.goals_of_care_summary,
      primarySymptoms: r.primary_symptoms,
      activeMedications: r.active_medications,
      goals: r.goals,
      interventions: r.interventions,
      monitoring: r.monitoring,
      escalation: r.escalation,
      reviewOn: r.review_on,
      snapshotVisitId: r.snapshot_visit_id,
      snapshotVisitDay: r.snapshot_visit_day,
      createdByName: r.created_by_name,
      createdAt: r.created_at.toISOString(),
    }));
  });
}
