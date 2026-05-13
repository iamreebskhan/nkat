/**
 * Visit service — Prisma I/O against the `visit` table.
 *
 * Every read + write tenant-scoped via withOrgContext.
 */
import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import {
  type DocumentVisit,
  type ScheduleVisit,
  type VisitStatus,
  type VisitType,
  type VisitView,
} from "./visit.types";
import { canTransition, computeTotalMinutes } from "./visit-pure";

interface VisitRow {
  id: string;
  patient_id: string;
  clinician_user_id: string;
  visit_type: VisitType;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  start_time: Date | null;
  stop_time: Date | null;
  total_minutes: number | null;
  acp_minutes: number | null;
  prolonged_minutes: number | null;
  is_telehealth: boolean;
  telehealth_modality: string | null;
  telehealth_consent_documented: boolean | null;
  document_text: string | null;
  cpt_codes_assigned: string[] | null;
  icd10_codes: string[] | null;
  modifiers: string[] | null;
  status: VisitStatus;
  signed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToView(row: VisitRow): VisitView {
  return {
    id: row.id,
    patientId: row.patient_id,
    clinicianUserId: row.clinician_user_id,
    visitType: row.visit_type,
    scheduledStart: row.scheduled_start?.toISOString() ?? null,
    scheduledEnd: row.scheduled_end?.toISOString() ?? null,
    startTime: row.start_time?.toISOString() ?? null,
    stopTime: row.stop_time?.toISOString() ?? null,
    totalMinutes: row.total_minutes,
    acpMinutes: row.acp_minutes ?? 0,
    prolongedMinutes: row.prolonged_minutes ?? 0,
    isTelehealth: row.is_telehealth,
    telehealthModality:
      (row.telehealth_modality as VisitView["telehealthModality"]) ?? null,
    telehealthConsentDocumented: row.telehealth_consent_documented ?? false,
    documentText: row.document_text,
    cptCodesAssigned: row.cpt_codes_assigned ?? [],
    icd10Codes: row.icd10_codes ?? [],
    modifiers: row.modifiers ?? [],
    status: row.status,
    signedAt: row.signed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function scheduleVisit(args: {
  orgId: string;
  payload: ScheduleVisit;
}): Promise<{ id: string }> {
  const { orgId, payload } = args;
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO visit (
        org_id, patient_id, clinician_user_id, visit_type,
        scheduled_start, scheduled_end,
        is_telehealth, telehealth_modality,
        status
      ) VALUES (
        ${orgId}::uuid, ${payload.patientId}::uuid, ${payload.clinicianUserId}::uuid,
        ${payload.visitType},
        ${payload.scheduledStart}::timestamptz,
        ${payload.scheduledEnd ?? null}::timestamptz,
        ${payload.isTelehealth ?? false},
        ${payload.telehealthModality ?? null},
        'scheduled'
      )
      RETURNING id
    `;
    if (!rows[0]) throw new Error("scheduleVisit: insert returned no row.");
    return { id: rows[0].id };
  });
}

export async function getVisit(args: {
  orgId: string;
  id: string;
}): Promise<VisitView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<VisitRow[]>`
      SELECT id, patient_id, clinician_user_id, visit_type,
             scheduled_start, scheduled_end, start_time, stop_time,
             total_minutes, acp_minutes, prolonged_minutes,
             is_telehealth, telehealth_modality, telehealth_consent_documented,
             document_text, cpt_codes_assigned, icd10_codes, modifiers,
             status, signed_at, created_at, updated_at
      FROM visit
      WHERE id = ${args.id}::uuid
      LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

export async function listVisits(args: {
  orgId: string;
  patientId?: string;
  status?: VisitStatus;
  clinicianUserId?: string;
  limit?: number;
}): Promise<VisitView[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  return withOrgContext(args.orgId, async (tx) => {
    // Filter pattern: parameterize each filter, NULL-out the unused ones.
    const rows = await tx.$queryRaw<VisitRow[]>`
      SELECT id, patient_id, clinician_user_id, visit_type,
             scheduled_start, scheduled_end, start_time, stop_time,
             total_minutes, acp_minutes, prolonged_minutes,
             is_telehealth, telehealth_modality, telehealth_consent_documented,
             document_text, cpt_codes_assigned, icd10_codes, modifiers,
             status, signed_at, created_at, updated_at
      FROM visit
      WHERE
        (${args.patientId ?? null}::uuid IS NULL OR patient_id = ${args.patientId ?? null}::uuid)
        AND (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
        AND (${args.clinicianUserId ?? null}::uuid IS NULL OR clinician_user_id = ${args.clinicianUserId ?? null}::uuid)
      ORDER BY COALESCE(start_time, scheduled_start, created_at) DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToView);
  });
}

/**
 * Save the clinician's documentation. Recomputes total_minutes from
 * start/stop on every save so the cached value can't drift.
 */
export async function documentVisit(args: {
  orgId: string;
  id: string;
  payload: DocumentVisit;
}): Promise<{ updated: boolean }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const exists = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM visit WHERE id = ${args.id}::uuid LIMIT 1
    `;
    if (exists.length === 0) throw new NotFoundError("Visit not found.");
    const startTs = p.startTime ? new Date(p.startTime) : null;
    const stopTs = p.stopTime ? new Date(p.stopTime) : null;
    const computed = computeTotalMinutes(startTs, stopTs);
    const total = p.totalMinutes ?? computed ?? null;

    await tx.$executeRaw`
      UPDATE visit SET
        start_time = COALESCE(${startTs}::timestamptz, start_time),
        stop_time  = COALESCE(${stopTs}::timestamptz, stop_time),
        total_minutes = COALESCE(${total}, total_minutes),
        acp_minutes = COALESCE(${p.acpMinutes ?? null}, acp_minutes),
        prolonged_minutes = COALESCE(${p.prolongedMinutes ?? null}, prolonged_minutes),
        document_text = COALESCE(${p.documentText ?? null}, document_text),
        cpt_codes_assigned = COALESCE(${p.cptCodesAssigned ?? null}::text[], cpt_codes_assigned),
        icd10_codes = COALESCE(${p.icd10Codes ?? null}::text[], icd10_codes),
        modifiers = COALESCE(${p.modifiers ?? null}::text[], modifiers),
        is_telehealth = COALESCE(${p.isTelehealth ?? null}, is_telehealth),
        telehealth_modality = COALESCE(${p.telehealthModality ?? null}, telehealth_modality),
        telehealth_consent_documented = COALESCE(${p.telehealthConsentDocumented ?? null}, telehealth_consent_documented),
        status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END,
        updated_at = now()
      WHERE id = ${args.id}::uuid
    `;
    return { updated: true };
  });
}

/**
 * Transition the visit status. Validates the FROM→TO move via
 * `canTransition`; throws otherwise so the caller can return 422.
 */
export async function transitionVisit(args: {
  orgId: string;
  id: string;
  to: VisitStatus;
  signedByUserId?: string;
}): Promise<{ from: VisitStatus; to: VisitStatus }> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ status: VisitStatus }[]>`
      SELECT status FROM visit WHERE id = ${args.id}::uuid LIMIT 1
    `;
    const from = rows[0]?.status;
    if (!from) throw new NotFoundError("Visit not found.");
    if (!canTransition(from, args.to)) {
      throw new Error(`Illegal status transition ${from} → ${args.to}`);
    }

    if (args.to === "documented") {
      await tx.$executeRaw`
        UPDATE visit SET
          status = 'documented',
          signed_at = now(),
          signed_by_user_id = ${args.signedByUserId ?? null}::uuid,
          updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
    } else {
      await tx.$executeRaw`
        UPDATE visit SET status = ${args.to}, updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
    }
    return { from, to: args.to };
  });
}
