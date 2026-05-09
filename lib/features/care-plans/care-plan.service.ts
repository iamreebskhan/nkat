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
 */
import { withOrgContext } from "@/lib/db";

export interface CarePlanView {
  id: string;
  patientId: string;
  document: unknown; // TipTap JSON document
  goalsOfCareSummary: string | null;
  primarySymptoms: string[];
  activeMedications: string[];
  currentVersion: number;
  lastUpdatedVisitId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCarePlanArgs {
  orgId: string;
  patientId: string;
  document: unknown;
  goalsOfCareSummary?: string | null;
  primarySymptoms?: string[];
  activeMedications?: string[];
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
    const upsert = await tx.$queryRaw<
      { id: string; current_version: number }[]
    >`
      INSERT INTO care_plan (
        org_id, patient_id, document, goals_of_care_summary,
        primary_symptoms, active_medications,
        last_updated_visit_id
      ) VALUES (
        ${args.orgId}::uuid, ${args.patientId}::uuid,
        ${JSON.stringify(args.document)}::jsonb,
        ${args.goalsOfCareSummary ?? null},
        ${args.primarySymptoms ?? []}::text[],
        ${args.activeMedications ?? []}::text[],
        ${args.snapshotForVisitId ?? null}::uuid
      )
      ON CONFLICT (patient_id) DO UPDATE SET
        document = EXCLUDED.document,
        goals_of_care_summary = COALESCE(EXCLUDED.goals_of_care_summary, care_plan.goals_of_care_summary),
        primary_symptoms = EXCLUDED.primary_symptoms,
        active_medications = EXCLUDED.active_medications,
        last_updated_visit_id = COALESCE(EXCLUDED.last_updated_visit_id, care_plan.last_updated_visit_id),
        current_version = care_plan.current_version + 1,
        updated_at = now()
      RETURNING id, current_version
    `;
    const { id, current_version } = upsert[0]!;

    if (args.snapshotForVisitId) {
      await tx.$executeRaw`
        INSERT INTO care_plan_version (
          org_id, care_plan_id, version, document, snapshot_visit_id, created_by_user_id
        ) VALUES (
          ${args.orgId}::uuid, ${id}::uuid, ${current_version},
          ${JSON.stringify(args.document)}::jsonb,
          ${args.snapshotForVisitId}::uuid,
          ${args.signedByUserId ?? null}::uuid
        )
        ON CONFLICT (care_plan_id, version) DO NOTHING
      `;
    }

    return { id, version: current_version };
  });
}

interface CarePlanRow {
  id: string;
  patient_id: string;
  document: unknown;
  goals_of_care_summary: string | null;
  primary_symptoms: string[] | null;
  active_medications: string[] | null;
  current_version: number;
  last_updated_visit_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getCarePlan(args: {
  orgId: string;
  patientId: string;
}): Promise<CarePlanView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<CarePlanRow[]>`
      SELECT id, patient_id, document, goals_of_care_summary,
             primary_symptoms, active_medications, current_version,
             last_updated_visit_id, created_at, updated_at
      FROM care_plan
      WHERE patient_id = ${args.patientId}::uuid
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      patientId: r.patient_id,
      document: r.document,
      goalsOfCareSummary: r.goals_of_care_summary,
      primarySymptoms: r.primary_symptoms ?? [],
      activeMedications: r.active_medications ?? [],
      currentVersion: r.current_version,
      lastUpdatedVisitId: r.last_updated_visit_id,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  });
}

export interface CarePlanVersionView {
  version: number;
  document: unknown;
  snapshotVisitId: string | null;
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
        snapshot_visit_id: string | null;
        created_at: Date;
      }[]
    >`
      SELECT v.version, v.document, v.snapshot_visit_id, v.created_at
      FROM care_plan_version v
      JOIN care_plan cp ON cp.id = v.care_plan_id
      WHERE cp.patient_id = ${args.patientId}::uuid
      ORDER BY v.version DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      version: r.version,
      document: r.document,
      snapshotVisitId: r.snapshot_visit_id,
      createdAt: r.created_at.toISOString(),
    }));
  });
}
