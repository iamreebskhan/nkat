/**
 * Visit service — Prisma I/O against the `visit` table.
 *
 * Every read + write tenant-scoped via withOrgContext.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { normalizeUnits, unitErrors } from "@/lib/features/billing/code-units";
import { orgLocalDate } from "@/lib/features/org/org-date";
import { acpOverTotalProblem } from "./cpt-suggester";
import {
  NEW_PATIENT_LOOKBACK_YEARS,
  VISIT_TYPES,
  type DocumentVisit,
  type ScheduleVisit,
  type VisitStatus,
  type VisitType,
  type VisitTypeHint,
  type VisitView,
} from "./visit.types";
import { canTransition, computeTotalMinutes, noteIsEmpty } from "./visit-pure";

interface VisitRow {
  id: string;
  patient_id: string;
  clinician_user_id: string;
  visit_type: string;
  visit_type_label?: string | null;
  coding_basis?: VisitType | null;
  /** org_visit_type.is_telehealth: the type forces telehealth (audit R22). */
  type_is_telehealth?: boolean | null;
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
  place_of_service_code?: string | null;
  signed_by_user_id?: string | null;
  signer_name?: string | null;
  signer_credential?: string | null;
  document_text: string | null;
  cpt_codes_assigned: string[] | null;
  /** Units per code (0106); absent from reads that do not select it. */
  cpt_units?: Record<string, number> | null;
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
  /** org.timezone, joined by getVisit and listVisits for serviceDay. */
  org_timezone?: string | null;
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

/** The visit's day where the practice is, when the read joined the org's zone. */
function serviceDayOf(row: VisitRow): string | null {
  const at = row.start_time ?? row.scheduled_start;
  return at && row.org_timezone ? orgLocalDate(at, row.org_timezone) : null;
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
    visitTypeIsTelehealth: row.type_is_telehealth === true,
    scheduledStart: row.scheduled_start?.toISOString() ?? null,
    scheduledEnd: row.scheduled_end?.toISOString() ?? null,
    startTime: row.start_time?.toISOString() ?? null,
    stopTime: row.stop_time?.toISOString() ?? null,
    serviceDay: serviceDayOf(row),
    totalMinutes: row.total_minutes,
    acpMinutes: row.acp_minutes ?? 0,
    prolongedMinutes: row.prolonged_minutes ?? 0,
    isTelehealth: row.is_telehealth,
    telehealthModality:
      (row.telehealth_modality as VisitView["telehealthModality"]) ?? null,
    telehealthConsentDocumented: row.telehealth_consent_documented ?? false,
    placeOfServiceCode: row.place_of_service_code ?? null,
    signedByUserId: row.signed_by_user_id ?? null,
    signerName: row.signer_name ?? null,
    signerCredential: row.signer_credential ?? null,
    documentText: row.document_text,
    cptCodesAssigned: row.cpt_codes_assigned ?? [],
    cptUnits: row.cpt_units ?? {},
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
    // active types, or visit_type stops being trustworthy. org_id is named as
    // well as enforced by RLS: slugs repeat across orgs with different flags,
    // and on a connection that bypasses RLS the slug alone found another
    // org's row (its telehealth flag, or a type this org does not have).
    const known = await tx.$queryRaw<{ slug: string; is_telehealth: boolean | null }[]>`
      SELECT slug, is_telehealth FROM org_visit_type
       WHERE org_id = ${orgId}::uuid AND slug = ${payload.visitType} AND active
       LIMIT 1
    `;
    if (!known[0]) {
      throw new ValidationError(`"${payload.visitType}" is not one of your visit types.`);
    }
    // A telehealth type is always a telehealth visit (audit R22). The box can
    // add the modality to any type but cannot take it off a type that forces
    // it — the "Telehealth" type with the box unticked used to bill an
    // in-person visit at POS 12 with no modifier.
    const forcedTelehealth = known[0].is_telehealth === true;
    const isTelehealth = (payload.isTelehealth ?? false) || forcedTelehealth;
    const modality = payload.telehealthModality ?? (forcedTelehealth ? "audio_video" : null);
    // app_user is global, so the FK on visit.clinician_user_id accepts ANY
    // user id. The /schedule picker only offers active members, but nothing
    // here checked, so a direct POST could book a removed member — whose
    // visit then nobody can open — or a user id from another tenant, which
    // lands on this org's calendar under a stranger's name. The column is NOT
    // NULL and ScheduleVisit requires a uuid, so every visit has a clinician
    // and this always runs. org_id is named as well as relied on through RLS,
    // so the guard holds even if the tenant GUC is ever missed.
    const member = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM org_member
       WHERE org_id = ${orgId}::uuid
         AND user_id = ${payload.clinicianUserId}::uuid
         AND status = 'active'
       LIMIT 1
    `;
    if (!member[0]) {
      throw new ValidationError(
        `Clinician ${payload.clinicianUserId} is not an active member of this organization. Pick someone from the Clinician list.`,
      );
    }
    // The patient must be one of this org's. RLS does not cover this even on
    // the app role: visit_patient_id_fkey references patient(id) alone, a
    // foreign-key check skips row security, and visit has no trigger, so the
    // INSERT below accepted another org's patient id. Named by org, as the
    // member guard above is.
    const patient = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM patient
       WHERE org_id = ${orgId}::uuid
         AND id = ${payload.patientId}::uuid
       LIMIT 1
    `;
    if (!patient[0]) {
      throw new ValidationError(
        `Patient ${payload.patientId} is not one of this organization's patients.`,
      );
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
        ${isTelehealth},
        ${modality},
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
             COALESCE(t.is_telehealth, false) AS type_is_telehealth,
             v.scheduled_start, v.scheduled_end, v.start_time, v.stop_time,
             v.total_minutes, v.acp_minutes, v.prolonged_minutes,
             v.is_telehealth, v.telehealth_modality, v.telehealth_consent_documented,
             v.document_text, v.cpt_codes_assigned, v.cpt_units, v.icd10_codes, v.modifiers,
             v.status, v.signed_at, v.created_at, v.updated_at,
             v.place_of_service_code,
             -- Who signed, under which credential, and the clinician of record
             -- (audit R32): the screen that attests the note can say so.
             v.signed_by_user_id, v.signer_credential,
             su.full_name AS signer_name, cu.full_name AS clinician_name,
             -- For serviceDay: the visit's day where the practice is (0107).
             o.timezone AS org_timezone
      FROM visit v
      LEFT JOIN org o ON o.id = v.org_id
      -- The visit's own org's type. Slugs repeat across orgs with different
      -- bands (bereavement_follow_up is not billed in one org and established
      -- in another), and on a connection that bypasses RLS a join on the slug
      -- alone read another org's band.
      LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
      LEFT JOIN app_user su ON su.id = v.signed_by_user_id
      LEFT JOIN app_user cu ON cu.id = v.clinician_user_id
      -- The org is named as well as enforced by RLS, so another org's visit
      -- is not found by its id even on a connection that bypasses RLS.
      WHERE v.id = ${args.id}::uuid
        AND v.org_id = ${args.orgId}::uuid
      LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

/**
 * Phase E.2 capacity guard — how many visits the clinician already has on
 * the practice's calendar day of `at`, vs the org's daily cap.
 *
 * Both days are the practice's (0107), worked out in SQL in org.timezone, and
 * `at` is read by the same ::timestamptz the INSERT stores it with. This took
 * the UTC slice of `at` and each visit's day in the database session's zone,
 * so after 8 pm in Ohio a new visit was counted against the next day: with a
 * cap of one, a 9 pm visit was booked beside the same day's 9 am visit.
 *
 * A visit being moved is not counted against its new day: it is the visit the
 * count is asked about, and counting it refused a move within its own day once
 * that day was full.
 */
export async function getDailyCapacityStatus(args: {
  orgId: string;
  clinicianUserId: string;
  /** The new visit's start: an instant, as the schedule request carries it. */
  at: string;
  /** The visit being moved there, which the count leaves out. */
  excludeVisitId?: string;
}): Promise<{ count: number; capacity: number; over: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const org = await tx.$queryRaw<{ daily_visit_capacity: number; timezone: string }[]>`
      SELECT daily_visit_capacity, timezone FROM org WHERE id = ${args.orgId}::uuid LIMIT 1
    `;
    if (!org[0]) throw new NotFoundError("Organization not found.");
    const capacity = org[0].daily_visit_capacity ?? 8;
    const tz = org[0].timezone;
    const cnt = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM visit
       WHERE clinician_user_id = ${args.clinicianUserId}::uuid
         AND status NOT IN ('cancelled', 'no_show')
         AND (COALESCE(scheduled_start, start_time) AT TIME ZONE ${tz})::date
             = (${args.at}::timestamptz AT TIME ZONE ${tz})::date
         AND org_id = ${args.orgId}::uuid
         AND (${args.excludeVisitId ?? null}::uuid IS NULL OR id <> ${args.excludeVisitId ?? null}::uuid)
    `;
    const count = Number(cnt[0]?.n ?? 0);
    return { count, capacity, over: count >= capacity };
  });
}

/**
 * Reschedule a visit to a new start (drag-to-reschedule on the grid).
 *
 *   - Only a visit that is still scheduled, in this org. The org is named as
 *     well as enforced by RLS, as changeVisitType names it, so the id alone
 *     never moves another org's visit on a connection that bypasses RLS.
 *   - The end: one sent with the start is written as sent, and null clears
 *     it. With none sent, which is how the grid moves a visit, the visit
 *     keeps its length, and a visit with no end still has none. The route
 *     used to turn a missing end into NULL, so every drag erased the end.
 *   - An end at or before the start is refused.
 *   - One visit_reschedule audit row in the same transaction, written only
 *     when something changed: a failed audit write blocks the move. The
 *     payload names the columns that changed, never the times, which are a
 *     date of service. A visit put back where it already is writes nothing.
 *   - When it did move, `moved` says where to, and whose visit it is, so the
 *     caller can move the clinician's Google Calendar event with it.
 */
export async function rescheduleVisit(args: {
  orgId: string;
  id: string;
  scheduledStart: string;
  /** Left out: the visit keeps its length. null: the end is cleared. */
  scheduledEnd?: string | null;
  actorUserId: string | null;
}): Promise<{ updated: boolean; moved?: RescheduledVisit }> {
  const start = new Date(args.scheduledStart);
  if (args.scheduledEnd != null && new Date(args.scheduledEnd).getTime() <= start.getTime()) {
    throw new ValidationError("The end time must be after the start time.");
  }
  return withOrgContext(args.orgId, async (tx) => {
    // Locked, so a second move of the same visit reads this one's result
    // rather than the length both started from.
    const rows = await tx.$queryRaw<
      {
        scheduled_start: Date | null;
        scheduled_end: Date | null;
        clinician_user_id: string;
        patient_id: string;
        visit_type: string;
      }[]
    >`
      SELECT scheduled_start, scheduled_end, clinician_user_id, patient_id, visit_type FROM visit
       WHERE id = ${args.id}::uuid
         AND org_id = ${args.orgId}::uuid
         AND status = 'scheduled'
       LIMIT 1
       FOR UPDATE
    `;
    const was = rows[0];
    if (!was) return { updated: false };

    const end = endAfterMove(
      { start: was.scheduled_start, end: was.scheduled_end },
      args.scheduledStart,
      args.scheduledEnd,
    );

    const same = (before: Date | null, after: string | null) =>
      before === null ? after === null : after !== null && before.getTime() === new Date(after).getTime();
    // Sorted, as before.
    const fields = [
      ...(same(was.scheduled_end, end) ? [] : ["scheduled_end"]),
      ...(same(was.scheduled_start, args.scheduledStart) ? [] : ["scheduled_start"]),
    ];
    if (fields.length === 0) return { updated: true };

    const n = await tx.$executeRaw`
      UPDATE visit
         SET scheduled_start = ${args.scheduledStart}::timestamptz,
             scheduled_end = ${end}::timestamptz,
             updated_at = now()
       WHERE id = ${args.id}::uuid
         AND org_id = ${args.orgId}::uuid
         AND status = 'scheduled'
    `;
    if (n === 0) return { updated: false };

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId,
      action: "visit_reschedule",
      targetType: "visit",
      targetId: args.id,
      payload: { fields },
    });
    return {
      updated: true,
      moved: {
        clinicianUserId: was.clinician_user_id,
        patientId: was.patient_id,
        visitType: was.visit_type,
        start: start.toISOString(),
        end,
      },
    };
  });
}

/** Where a rescheduled visit went, and whose it is. */
export interface RescheduledVisit {
  clinicianUserId: string;
  patientId: string;
  visitType: string;
  start: string;
  end: string | null;
}

/**
 * A moved visit's end: one sent with the start, as sent (null clears it);
 * none sent, the visit keeps its length; and a visit with no end has none.
 * rescheduleVisit writes this, and the reschedule route checks the same window
 * for conflicts before the move.
 */
export function endAfterMove(
  was: { start: Date | string | null; end: Date | string | null },
  newStart: string,
  sentEnd: string | null | undefined,
): string | null {
  if (sentEnd !== undefined) return sentEnd;
  if (!was.start || !was.end) return null;
  const length = new Date(was.end).getTime() - new Date(was.start).getTime();
  return new Date(new Date(newStart).getTime() + length).toISOString();
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
             COALESCE(t.is_telehealth, false) AS type_is_telehealth,
             v.scheduled_start, v.scheduled_end, v.start_time, v.stop_time,
             v.total_minutes, v.acp_minutes, v.prolonged_minutes,
             v.is_telehealth, v.telehealth_modality, v.telehealth_consent_documented,
             v.document_text, v.cpt_codes_assigned, v.cpt_units, v.icd10_codes, v.modifiers,
             v.status, v.signed_at, v.created_at, v.updated_at,
             (p.first_name || ' ' || p.last_name) AS patient_name,
             p.city AS patient_city,
             u.full_name AS clinician_name,
             -- For serviceDay, as in getVisit.
             o.timezone AS org_timezone
      FROM visit v
      LEFT JOIN org o ON o.id = v.org_id
      -- The visit's own org's patient: a visit booked on another org's
      -- patient id (the FK is id-only) must not show that patient's name.
      LEFT JOIN patient p ON p.id = v.patient_id AND p.org_id = v.org_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      -- The visit's own org's type, as in getVisit.
      LEFT JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
      -- The org is named as well as enforced by RLS. countVisits in
      -- app/api/visits/route.ts repeats this WHERE character for character.
      WHERE
        v.org_id = ${args.orgId}::uuid
        AND (${args.patientId ?? null}::uuid IS NULL OR v.patient_id = ${args.patientId ?? null}::uuid)
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
export const LOCKED_AFTER_SIGNING: VisitStatus[] = ["documented", "pending_billing", "billed"];

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
    // The org is named as well as enforced by RLS, here and in the two
    // statements below, so another org's visit reads as not found.
    const exists = await tx.$queryRaw<{ id: string; status: VisitStatus }[]>`
      SELECT id, status FROM visit WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid LIMIT 1
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
    // A telehealth visit type forces the modality (audit R22). Clearing the
    // box on one would bill an in-person visit — POS 12, no 95/93 — for an
    // encounter the org defined as telehealth. Asked only when the box is
    // being cleared, and in its own query so the status read above stays the
    // one the document-lock guard dispatches on.
    if (p.isTelehealth === false) {
      const type = await tx.$queryRaw<{ is_telehealth: boolean | null }[]>`
        SELECT t.is_telehealth
          FROM visit v
          JOIN org_visit_type t ON t.slug = v.visit_type AND t.org_id = v.org_id
         WHERE v.id = ${args.id}::uuid
           AND v.org_id = ${args.orgId}::uuid
         LIMIT 1
      `;
      if (Array.isArray(type) && type[0]?.is_telehealth === true) {
        throw new ValidationError(
          "This visit's type is a telehealth type, so the visit stays telehealth. An in-person visit needs an in-person visit type.",
        );
      }
    }
    // Where the visit took place (audit R23): a real CMS code, or refuse.
    if (p.placeOfServiceCode) {
      const known = await tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM pos
         WHERE pos = ${p.placeOfServiceCode}
           AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
         LIMIT 1
      `;
      if (!Array.isArray(known) || !known[0]) {
        throw new ValidationError(`Unknown place-of-service code "${p.placeOfServiceCode}".`);
      }
    }
    // Units above one only on the per-increment add-ons (0106): a home E/M is
    // reported once per date of service, so 99350 × 2 is refused, not stored.
    const unitProblems = p.cptUnits ? unitErrors(p.cptCodesAssigned ?? [], p.cptUnits) : [];
    if (unitProblems.length > 0) throw new ValidationError(unitProblems.join(" "));
    // The count is written only beside the codes it counts. Codes sent alone
    // reset it to one unit each; no codes leaves it as it is. Never an empty
    // map on a save that sent no codes: '{}'::jsonb is a value, not a NULL, so
    // the COALESCE below would wipe the visit's count.
    const units = p.cptCodesAssigned ? normalizeUnits(p.cptCodesAssigned, p.cptUnits) : null;
    const startTs = p.startTime ? new Date(p.startTime) : null;
    const stopTs = p.stopTime ? new Date(p.stopTime) : null;
    const computed = computeTotalMinutes(startTs, stopTs);
    const total = p.totalMinutes ?? computed ?? null;
    // Writing the legacy free-text note starts a note, so it takes the same
    // pin every other write that starts one takes: the version the note is
    // written under, kept for the life of the note. Without it a template edit
    // moved such a note to the new version, which the settings screen promises
    // it never does. noteIsEmpty is the sign guard's own rule, so an untouched
    // editor — which still serialises to a document — pins nothing. Bound into
    // the same UPDATE: no extra round trip, and it cannot half-apply.
    const startsNote = !noteIsEmpty(p.documentText ?? null);
    // The type the sender coded against, when it says (DocumentVisitSchema).
    // Tested in the UPDATE itself, so a type change that commits in between
    // is seen too.
    const codedFor = p.visitType ?? null;

    const written = await tx.$executeRaw`
      UPDATE visit SET
        start_time = COALESCE(${startTs}::timestamptz, start_time),
        stop_time  = COALESCE(${stopTs}::timestamptz, stop_time),
        total_minutes = COALESCE(${total}, total_minutes),
        acp_minutes = COALESCE(${p.acpMinutes ?? null}, acp_minutes),
        prolonged_minutes = COALESCE(${p.prolongedMinutes ?? null}, prolonged_minutes),
        document_text = COALESCE(${p.documentText ?? null}, document_text),
        note_template_id = CASE WHEN ${startsNote}::boolean
          THEN COALESCE(note_template_id,
                 (SELECT nt.id FROM note_template nt
                   WHERE nt.org_id = visit.org_id AND nt.is_active LIMIT 1))
          ELSE note_template_id END,
        cpt_codes_assigned = COALESCE(${p.cptCodesAssigned ?? null}::text[], cpt_codes_assigned),
        cpt_units = COALESCE(${units === null ? null : JSON.stringify(units)}::jsonb, cpt_units),
        icd10_codes = COALESCE(${p.icd10Codes ?? null}::text[], icd10_codes),
        modifiers = COALESCE(${p.modifiers ?? null}::text[], modifiers),
        is_telehealth = COALESCE(${p.isTelehealth ?? null}, is_telehealth),
        telehealth_modality = COALESCE(${p.telehealthModality ?? null}, telehealth_modality),
        telehealth_consent_documented = COALESCE(${p.telehealthConsentDocumented ?? null}, telehealth_consent_documented),
        place_of_service_code = COALESCE(${p.placeOfServiceCode ?? null}, place_of_service_code),
        status = CASE WHEN status = 'scheduled' THEN 'in_progress' ELSE status END,
        updated_at = now()
      WHERE id = ${args.id}::uuid
        AND org_id = ${args.orgId}::uuid
        AND (${codedFor}::text IS NULL OR visit_type = ${codedFor})
    `;
    // The visit is there (read above), so nothing written means its type has
    // changed since the sender loaded it — in another tab, or by an admin
    // correcting it. Its codes are the old band's: a stale "Save draft" wrote
    // them back over the codes the change had cleared, and a stale "Sign +
    // submit", which saves first, then billed them.
    if (codedFor !== null && written === 0) {
      throw new ValidationError(
        "This visit's type was changed after this screen loaded it, so its codes were worked out for the old type. Nothing was saved — reload the page.",
      );
    }
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
    const rows = await tx.$queryRaw<
      {
        status: VisitStatus;
        document_text: string | null;
        filled_sections: bigint;
        has_vitals: boolean;
        missing_required: string[] | null;
        dx_count: number;
        clinician_user_id: string | null;
        signer_credential: string | null;
        is_telehealth: boolean | null;
        telehealth_consent_documented: boolean | null;
        coding_basis: string | null;
        resolved_template_id: string | null;
        total_minutes: number | null;
        acp_minutes: number | null;
      }[]
    >`
      SELECT v.status,
             v.document_text,
             v.clinician_user_id,
             v.is_telehealth,
             v.telehealth_consent_documented,
             v.total_minutes,
             v.acp_minutes,
             -- The template version missing_required below judges this note
             -- by, the same COALESCE, read in the same statement. Sign-off
             -- pins exactly this version; a fresh read of the active template
             -- at UPDATE time could land on an edit made mid-sign.
             COALESCE(v.note_template_id,
                      (SELECT nt.id FROM note_template nt
                        WHERE nt.org_id = v.org_id AND nt.is_active
                        LIMIT 1)) AS resolved_template_id,
             -- The band the visit's type bills as. A "Not billed" type rests at
             -- documented and never moves to billing (audit R18).
             (SELECT ot.coding_basis FROM org_visit_type ot
               WHERE ot.org_id = v.org_id AND ot.slug = v.visit_type
               LIMIT 1) AS coding_basis,
             -- The signer's credential as recorded on the Team page, snapshotted
             -- into the visit at sign-off (audit R32).
             (SELECT cp.credential FROM clinician_profile cp
               WHERE cp.org_id = v.org_id
                 AND cp.user_id = ${args.signedByUserId ?? null}::uuid) AS signer_credential,
             -- Diagnoses recorded on THIS visit. Never the intake diagnosis.
             COALESCE(array_length(v.icd10_codes, 1), 0)::int AS dx_count,
             (SELECT count(*) FROM visit_note_section s
               WHERE s.visit_id = v.id AND NOT s.is_empty)      AS filled_sections,
             EXISTS (SELECT 1 FROM visit_vitals vv
                      WHERE vv.visit_id = v.id
                        AND num_nonnulls(vv.height_cm, vv.weight_kg, vv.bp_systolic,
                                         vv.bp_diastolic, vv.heart_rate, vv.resp_rate,
                                         vv.temperature_c, vv.spo2_percent,
                                         vv.pps_percent, vv.pain_score) > 0) AS has_vitals,
             -- Required sections still empty. Two things make this more than
             -- a NOT NULL check:
             --
             -- 1. Requiredness is per visit type. A physical exam is required
             --    on a home visit and impossible on a telehealth call, so the
             --    section's exception list is checked against this visit's own
             --    type. Identical rule to sectionIsRequiredFor().
             -- 2. A vitals section is satisfied by visit_vitals, never by its
             --    own (always-empty) content row, so it is checked against the
             --    same num_nonnulls test has_vitals uses.
             (SELECT array_agg(t.label ORDER BY t.sort_order)
                FROM note_template_section t
                LEFT JOIN visit_note_section s
                       ON s.visit_id = v.id AND s.section_key = t.section_key
               -- The visit's pin, else the org's active template. The pin
               -- (note_template_id) is the version the note was started
               -- under, set by saving a section, carry-forward, recording
               -- vitals, and sign-off, so a visit without one has nothing in
               -- its structured note yet. Joining on that NULL matched no
               -- rows, which made the whole required-section check silently
               -- pass. A guard that disappears precisely when nothing has
               -- been documented is worse than no guard, because it reads as
               -- enforcement.
               WHERE t.template_id = COALESCE(
                       v.note_template_id,
                       (SELECT nt.id FROM note_template nt
                         WHERE nt.org_id = v.org_id AND nt.is_active
                         LIMIT 1))
                 AND t.is_required
                 AND NOT (v.visit_type = ANY (t.not_required_for_visit_types))
                 -- Telehealth is the visit's own flag, not only a type (audit
                 -- R22): a "telehealth" exception exempts a video visit of any
                 -- type. Same rule as sectionIsRequiredFor(..., isTelehealth).
                 AND NOT (COALESCE(v.is_telehealth, false)
                          AND 'telehealth' = ANY (t.not_required_for_visit_types))
                 AND CASE
                       WHEN t.kind = 'vitals' THEN NOT EXISTS (
                         SELECT 1 FROM visit_vitals vv
                          WHERE vv.visit_id = v.id
                            AND num_nonnulls(vv.height_cm, vv.weight_kg, vv.bp_systolic,
                                             vv.bp_diastolic, vv.heart_rate, vv.resp_rate,
                                             vv.temperature_c, vv.spo2_percent,
                                             vv.pps_percent, vv.pain_score) > 0)
                       ELSE (s.id IS NULL OR s.is_empty)
                     END)                                        AS missing_required
        FROM visit v
       -- The org is named as well as enforced by RLS. This read is the only
       -- org gate in front of the UPDATEs and the audit row below: the
       -- transition route takes no requireVisitAccess (a covering signer is
       -- allowed), and the UPDATE's count is never checked.
       WHERE v.id = ${args.id}::uuid
         AND v.org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    const from = rows[0]?.status;
    if (!from) throw new NotFoundError("Visit not found.");
    if (!canTransition(from, args.to)) {
      throw new ValidationError(`Illegal status transition ${from} → ${args.to}`);
    }
    // A "Not billed" visit type (audit R18) is signed and stops there. Moving
    // it on would put an encounter the org has said is never billed into the
    // billing queue, and the transition route drafts a bill on this very edge,
    // so the refusal lives here where every caller passes. Documented is where
    // these visits rest.
    if (args.to === "pending_billing" && rows[0].coding_basis === "non_billable") {
      throw new ValidationError("This visit type is not billed — it stays signed without a bill.");
    }

    // Signing is an attestation, and an attestation to nothing is worse than no
    // attestation: it produces a locked visit and a billable claim with no
    // documentation an auditor can compare the codes against. Checked only on
    // the sign-off edge — re-checking it on documented → pending_billing would
    // strand visits signed before this guard existed.
    //
    // Documentation can now live in three places, and any one of them counts:
    // a filled section of the structured note, a recorded vital sign, or the
    // legacy free-text column that visits written before 0088 still use.
    if (args.to === "documented") {
      const documented =
        Number(rows[0].filled_sections) > 0 ||
        rows[0].has_vitals ||
        !noteIsEmpty(rows[0].document_text);
      if (!documented) {
        throw new ValidationError(
          "This visit has no documentation. Write the note before signing — a signed note is the record an auditor compares the billed codes against.",
        );
      }
      // Beyond "something is written", the org's own template can mark
      // sections mandatory. Name them rather than refusing vaguely.
      const missing = rows[0].missing_required ?? [];
      if (missing.length > 0) {
        throw new ValidationError(
          `This note is missing ${missing.length === 1 ? "a required section" : "required sections"}: ${missing.join(", ")}. Complete ${missing.length === 1 ? "it" : "them"} before signing.`,
        );
      }
      // Every signed encounter must say what it addressed (audit R13). On a
      // billed visit the bill is built from these codes. Before the document
      // screen captured them, the claim silently inherited the intake
      // diagnosis or went out with none, and a claim with no ICD-10 is
      // rejected before review.
      if (Number(rows[0].dx_count ?? 0) === 0) {
        // Give the reason that is true for THIS visit. A "Not billed" type
        // never produces a claim, so blaming the bill contradicted both the
        // Diagnosis card the clinician had just read and the card below it
        // saying this visit drafts no bill. The requirement itself is R13's
        // and holds either way: a signed encounter must say what it was for.
        throw new ValidationError(
          rows[0].coding_basis === "non_billable"
            ? "Add at least one diagnosis (ICD-10) before signing. A signed encounter has to say what it was for."
            : "Add at least one diagnosis (ICD-10) before signing. The bill is built from the diagnoses recorded on this visit.",
        );
      }
      // A telehealth visit needs the patient's consent on record before it is
      // attested (audit R22). Only the document screen enforced this, so any
      // other API client could sign straight past it.
      if (rows[0].is_telehealth === true && rows[0].telehealth_consent_documented !== true) {
        throw new ValidationError(
          "Telehealth visit needs the patient's consent documented before signing.",
        );
      }
      // ACP time is spent during the visit, so it cannot be more than the
      // visit's total. Only the document screen's suggestion knew that, and
      // only once it did: nothing refused 40 ACP minutes on a 30-minute visit.
      const acpProblem = acpOverTotalProblem(rows[0].acp_minutes, rows[0].total_minutes);
      if (acpProblem) throw new ValidationError(acpProblem);
    }

    if (args.to === "documented") {
      await tx.$executeRaw`
        UPDATE visit SET
          status = 'documented',
          signed_at = now(),
          signed_by_user_id = ${args.signedByUserId ?? null}::uuid,
          signer_credential = ${rows[0]?.signer_credential ?? null},
          -- An attested note keeps the version it was signed under. Every
          -- write that starts a note pins it, so what still arrives unpinned
          -- is a note whose org had no active template to resolve to when it
          -- was written; the subselect above finds none either, and the pin
          -- stays NULL. Without a pin a later template edit would restate what
          -- the signed note's sections were. COALESCE keeps an existing pin.
          note_template_id = COALESCE(note_template_id,
                                      ${rows[0]?.resolved_template_id ?? null}::uuid),
          updated_at = now()
        WHERE id = ${args.id}::uuid
          AND org_id = ${args.orgId}::uuid
      `;
    } else {
      await tx.$executeRaw`
        UPDATE visit SET status = ${args.to}, updated_at = now()
        WHERE id = ${args.id}::uuid
          AND org_id = ${args.orgId}::uuid
      `;
    }

    // Signing is the clinically significant one: it locks the note and
    // releases it for billing, and it is the event an investigator asks about
    // first. Every other transition is recorded too, because "who moved this
    // to billed" has the same shape of answer.
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.signedByUserId ?? null,
      action: args.to === "documented" ? "visit_sign" : "visit_document",
      targetType: "visit",
      targetId: args.id,
      payload:
        args.to === "documented"
          ? {
              from,
              to: args.to,
              // Ids and flags only (audit R32): the credential the note was
              // attested under, and whether the signer is the clinician of record.
              credential: rows[0]?.signer_credential ?? null,
              signerIsClinicianOfRecord:
                !!args.signedByUserId && args.signedByUserId === rows[0]?.clinician_user_id,
            }
          : { from, to: args.to },
    });
    return { from, to: args.to };
  });
}

/** The statuses of a visit that took place, or is booked to. */
const PRIOR_VISIT_STATUSES: VisitStatus[] = [
  "scheduled",
  "in_progress",
  "documented",
  "pending_billing",
  "billed",
];

/**
 * What Pallio's own history says about new vs established for one patient on
 * one date: the latest visit in this org, by ANY clinician, in the
 * NEW_PATIENT_LOOKBACK_YEARS before `before` (CMS counts a service by another
 * clinician of the same specialty in the same group, so the caller's own visits
 * are not enough).
 *
 * Left out: cancelled and no-show visits, which did not happen, and visits on a
 * "Not billed" type, which Pallio defines as bereavement follow-ups and
 * caregiver-only visits where the patient is not seen. A slug with no type row
 * still counts, so an unknown case leans established. A visit that is only
 * booked counts too, and says so by its status.
 *
 * A hint for the screens, never a decision: the practice may have seen the
 * patient before it used Pallio, and nothing here can know that.
 */
export async function findPriorVisit(args: {
  orgId: string;
  patientId: string;
  before: Date;
  excludeVisitId?: string | null;
}): Promise<VisitTypeHint> {
  const windowStart = new Date(args.before);
  windowStart.setUTCFullYear(windowStart.getUTCFullYear() - NEW_PATIENT_LOOKBACK_YEARS);
  const excluded = args.excludeVisitId ?? null;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: VisitStatus; seen_at: Date }[]>`
      SELECT v.id, v.status, COALESCE(v.start_time, v.scheduled_start) AS seen_at
        FROM visit v
        -- The visit's own org's type: the same slug can bill differently in
        -- another org.
        LEFT JOIN org_visit_type t ON t.org_id = v.org_id AND t.slug = v.visit_type
       WHERE v.org_id = ${args.orgId}::uuid
         AND v.patient_id = ${args.patientId}::uuid
         AND (${excluded}::uuid IS NULL OR v.id <> ${excluded}::uuid)
         AND v.status = ANY(${PRIOR_VISIT_STATUSES}::text[])
         AND (t.coding_basis IS NULL OR t.coding_basis <> 'non_billable')
         AND COALESCE(v.start_time, v.scheduled_start) < ${args.before}::timestamptz
         AND COALESCE(v.start_time, v.scheduled_start) >= ${windowStart}::timestamptz
       ORDER BY COALESCE(v.start_time, v.scheduled_start) DESC
       LIMIT 1
    `;
    const prior = rows[0];
    return {
      lastVisitAt: prior ? prior.seen_at.toISOString() : null,
      lastVisitStatus: prior ? prior.status : null,
      windowStart: windowStart.toISOString(),
      suggestedBasis: prior ? "established_patient_home" : "new_patient_home",
    };
  });
}

/**
 * Correct a visit's type before it is signed.
 *
 * The scheduler used to start every visit on the established type, and nothing
 * could change visit_type afterwards, so a first visit left on that default was
 * coded on the established ladder and the only fix left was a code override on
 * the bill after signing. This is the correction, on the open visit.
 *
 *   - Only while the visit is scheduled or in progress: signing is an
 *     attestation. The UPDATE repeats that test, so a visit signed between the
 *     read and the write is refused rather than changed.
 *   - The type must be one of THIS org's active types. A visit keeping the
 *     type it already has is a no-op, even if that type has since been
 *     switched off.
 *   - A telehealth type makes the visit telehealth, as scheduleVisit does. The
 *     flag is never cleared here: an in-person visit is the clinician's call on
 *     the document screen.
 *   - When the band changes, the codes saved under the old band are cleared
 *     (with their units), so a stale code cannot ride on to the bill; the next
 *     save writes the new band's suggestion. The note-template pin, times,
 *     diagnoses, modifiers and place of service are never written.
 *   - One audit row in the same transaction: a failed audit write blocks the
 *     change. Closed-set bands only.
 */
export async function changeVisitType(args: {
  orgId: string;
  id: string;
  visitType: string;
  actorUserId: string | null;
}): Promise<{ changed: boolean; codesCleared: boolean; fromBasis: VisitType; toBasis: VisitType }> {
  return withOrgContext(args.orgId, async (tx) => {
    const current = await tx.$queryRaw<
      { status: VisitStatus; visit_type: string; coding_basis: VisitType | null }[]
    >`
      SELECT v.status, v.visit_type, t.coding_basis
        FROM visit v
        LEFT JOIN org_visit_type t ON t.org_id = v.org_id AND t.slug = v.visit_type
       WHERE v.id = ${args.id}::uuid
         AND v.org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    const visit = current[0];
    if (!visit) throw new NotFoundError("Visit not found.");
    // The status first, so a signed visit is told it is signed whatever it
    // was asked to become.
    if (LOCKED_AFTER_SIGNING.includes(visit.status)) {
      throw new ValidationError(
        "This visit is signed — its visit type can no longer be changed. Record a correction as an addendum; billing can correct codes on the bill.",
      );
    }
    if (visit.status === "cancelled" || visit.status === "no_show") {
      throw new ValidationError(
        visit.status === "cancelled"
          ? "This visit was cancelled — its visit type cannot be changed."
          : "This visit is marked as a no-show — its visit type cannot be changed.",
      );
    }
    // Always a member of the closed set, so the audit row never carries a
    // slug or label.
    const fromBasis = visit.coding_basis ?? coerceCodingBasis(visit.visit_type);
    if (args.visitType === visit.visit_type) {
      return { changed: false, codesCleared: false, fromBasis, toBasis: fromBasis };
    }

    // One of THIS org's active types. The same lookup scheduleVisit makes.
    const types = await tx.$queryRaw<
      { slug: string; coding_basis: VisitType; is_telehealth: boolean | null }[]
    >`
      SELECT slug, coding_basis, is_telehealth FROM org_visit_type
       WHERE org_id = ${args.orgId}::uuid
         AND slug = ${args.visitType}
         AND active
       LIMIT 1
    `;
    const target = types[0];
    if (!target) {
      throw new ValidationError(`"${args.visitType}" is not one of your visit types.`);
    }
    const toBasis = target.coding_basis;
    const forcedTelehealth = target.is_telehealth === true;
    const codesCleared = fromBasis !== toBasis;

    const written = await tx.$executeRaw`
      UPDATE visit SET
        visit_type = ${target.slug},
        is_telehealth = COALESCE(${forcedTelehealth ? true : null}::boolean, is_telehealth),
        telehealth_modality = COALESCE(telehealth_modality, ${forcedTelehealth ? "audio_video" : null}::text),
        cpt_codes_assigned = COALESCE(${codesCleared ? [] : null}::text[], cpt_codes_assigned),
        cpt_units = COALESCE(${codesCleared ? JSON.stringify({}) : null}::jsonb, cpt_units),
        updated_at = now()
      WHERE id = ${args.id}::uuid
        AND org_id = ${args.orgId}::uuid
        AND status = ANY(${["scheduled", "in_progress"]}::text[])
    `;
    if (written === 0) {
      throw new ValidationError(
        "This visit was signed while the type was being changed — nothing was changed.",
      );
    }

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId,
      action: "visit_type_change",
      targetType: "visit",
      targetId: args.id,
      payload: { fromBasis, toBasis, codesCleared },
    });
    return { changed: true, codesCleared, fromBasis, toBasis };
  });
}
