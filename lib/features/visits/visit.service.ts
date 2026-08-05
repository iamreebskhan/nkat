/**
 * Visit service — Prisma I/O against the `visit` table.
 *
 * Every read + write tenant-scoped via withOrgContext.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import {
  VISIT_TYPES,
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
  visit_type: string;
  visit_type_label?: string | null;
  coding_basis?: VisitType | null;
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
  // Optional joined display columns (listVisits only).
  patient_name?: string | null;
  patient_city?: string | null;
  clinician_name?: string | null;
}

function prettySlug(slug: string): string {
  const s = slug.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Last-resort band for a slug with no org_visit_type row (pre-0062 data). */
function coerceCodingBasis(slug: string): VisitType {
  return (VISIT_TYPES as readonly string[]).includes(slug)
    ? (slug as VisitType)
    : "established_patient_home";
}

function rowToView(row: VisitRow): VisitView {
  return {
    id: row.id,
    patientId: row.patient_id,
    clinicianUserId: row.clinician_user_id,
    visitType: row.visit_type,
    // Fall back to the slug for rows written before 0062, and treat an
    // unresolved slug as an established home visit — the commonest band —
    // rather than crashing the coder.
    visitTypeLabel: row.visit_type_label ?? prettySlug(row.visit_type),
    codingBasis: row.coding_basis ?? coerceCodingBasis(row.visit_type),
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
    patientName: row.patient_name ?? null,
    patientCity: row.patient_city ?? null,
    clinicianName: row.clinician_name ?? null,
  };
}

export async function scheduleVisit(args: {
  orgId: string;
  payload: ScheduleVisit;
}): Promise<{ id: string }> {
  const { orgId, payload } = args;
  return withOrgContext(orgId, async (tx) => {
    // visit.visit_type lost its DB CHECK in 0062 so orgs can define their own
    // types. This is what replaces it: the slug must be one of THIS org's
    // active types, or visit_type stops being trustworthy.
    const known = await tx.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM org_visit_type
       WHERE slug = ${payload.visitType} AND active
       LIMIT 1
    `;
    if (!known[0]) {
      throw new ValidationError(`"${payload.visitType}" is not one of your visit types.`);
    }
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
      SELECT v.id, v.patient_id, v.clinician_user_id, v.visit_type,
             t.label AS visit_type_label, t.coding_basis,
             v.scheduled_start, v.scheduled_end, v.start_time, v.stop_time,
             v.total_minutes, v.acp_minutes, v.prolonged_minutes,
             v.is_telehealth, v.telehealth_modality, v.telehealth_consent_documented,
             v.document_text, v.cpt_codes_assigned, v.icd10_codes, v.modifiers,
             v.status, v.signed_at, v.created_at, v.updated_at
      FROM visit v
      LEFT JOIN org_visit_type t ON t.slug = v.visit_type
      WHERE v.id = ${args.id}::uuid
      LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

/**
 * Phase E.2 capacity guard — how many visits the clinician already has on
 * the calendar day of `dayIso`, vs the org's daily cap.
 */
export async function getDailyCapacityStatus(args: {
  orgId: string;
  clinicianUserId: string;
  dayIso: string;
}): Promise<{ count: number; capacity: number; over: boolean }> {
  const day = args.dayIso.slice(0, 10);
  return withOrgContext(args.orgId, async (tx) => {
    const cap = await tx.$queryRaw<{ daily_visit_capacity: number }[]>`
      SELECT daily_visit_capacity FROM org WHERE id = ${args.orgId}::uuid LIMIT 1
    `;
    const capacity = cap[0]?.daily_visit_capacity ?? 8;
    const cnt = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM visit
       WHERE clinician_user_id = ${args.clinicianUserId}::uuid
         AND status NOT IN ('cancelled', 'no_show')
         AND date(COALESCE(scheduled_start, start_time)) = ${day}::date
    `;
    const count = Number(cnt[0]?.n ?? 0);
    return { count, capacity, over: count >= capacity };
  });
}

/** Reschedule a visit to a new start (drag-to-reschedule on the grid). */
export async function rescheduleVisit(args: {
  orgId: string;
  id: string;
  scheduledStart: string;
  scheduledEnd?: string | null;
}): Promise<{ updated: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const n = await tx.$executeRaw`
      UPDATE visit
         SET scheduled_start = ${args.scheduledStart}::timestamptz,
             scheduled_end = ${args.scheduledEnd ?? null}::timestamptz,
             updated_at = now()
       WHERE id = ${args.id}::uuid
         AND status = 'scheduled'
    `;
    return { updated: n > 0 };
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
      SELECT v.id, v.patient_id, v.clinician_user_id, v.visit_type,
             t.label AS visit_type_label, t.coding_basis,
             v.scheduled_start, v.scheduled_end, v.start_time, v.stop_time,
             v.total_minutes, v.acp_minutes, v.prolonged_minutes,
             v.is_telehealth, v.telehealth_modality, v.telehealth_consent_documented,
             v.document_text, v.cpt_codes_assigned, v.icd10_codes, v.modifiers,
             v.status, v.signed_at, v.created_at, v.updated_at,
             (p.first_name || ' ' || p.last_name) AS patient_name,
             p.city AS patient_city,
             u.full_name AS clinician_name
      FROM visit v
      LEFT JOIN patient p ON p.id = v.patient_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      LEFT JOIN org_visit_type t ON t.slug = v.visit_type
      WHERE
        (${args.patientId ?? null}::uuid IS NULL OR v.patient_id = ${args.patientId ?? null}::uuid)
        AND (${args.status ?? null}::text IS NULL OR v.status = ${args.status ?? null})
        AND (${args.clinicianUserId ?? null}::uuid IS NULL OR v.clinician_user_id = ${args.clinicianUserId ?? null}::uuid)
      ORDER BY COALESCE(v.start_time, v.scheduled_start, v.created_at) DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToView);
  });
}

/**
 * Statuses at or past sign-off. `documented` stamps signed_at, so from that
 * point the note is attested and frozen.
 */
const LOCKED_AFTER_SIGNING: VisitStatus[] = ["documented", "pending_billing", "billed"];

/**
 * Save the clinician's documentation. Recomputes total_minutes from
 * start/stop on every save so the cached value can't drift. Refuses once the
 * visit has been signed.
 */
export async function documentVisit(args: {
  orgId: string;
  id: string;
  payload: DocumentVisit;
}): Promise<{ updated: boolean }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const exists = await tx.$queryRaw<{ id: string; status: VisitStatus }[]>`
      SELECT id, status FROM visit WHERE id = ${args.id}::uuid LIMIT 1
    `;
    if (exists.length === 0) throw new NotFoundError("Visit not found.");
    // Signing is an attestation. Once the note is signed and on its way to
    // billing, silently rewriting it — which the editor's autosave-on-blur
    // did happily — leaves a claim supported by documentation nobody attested
    // to. Amendments belong in a follow-up addendum, not an invisible edit.
    if (LOCKED_AFTER_SIGNING.includes(exists[0]!.status)) {
      throw new ValidationError(
        "This visit is signed and submitted for billing — its documentation can no longer be edited.",
      );
    }
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
      throw new ValidationError(`Illegal status transition ${from} → ${args.to}`);
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
