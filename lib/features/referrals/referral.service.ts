/**
 * Referral service — the intake pipeline (Level-1 doc:22-28, 0111).
 *
 * A referral is received, worked (requirements, triage, insurance
 * verification), and closed by one of the pipeline's dispositions: admitted (the
 * intake wizard creates the patient and admitReferralInTx links them), not
 * taken under care with a reason code, or transitioned. Every write is
 * audited with ids, field names, stages and codes, never what was written.
 *
 * All reads and writes go through withOrgContext and name the org as well,
 * as everywhere else.
 */
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
import { moveReferralDocumentsToPatient } from "@/lib/features/patient-documents/patient-document.service";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";

import { ensureReasonCodes } from "./reason-code.service";
import {
  isOpenStage,
  OPEN_STAGES,
  REFERRAL_STAGES,
  stageMovesFrom,
  type CreateReferral,
  type ReferralRequirement,
  type ReferralRow,
  type ReferralStage,
  type ReferralSummary,
  type ReferralView,
  type StageChange,
  type Triage,
  type TriageView,
  type UpdateReferral,
  type Verification,
  type VerificationView,
} from "./referral.types";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

// ---------------------------------------------------------------------------
// Checks shared by create and update
// ---------------------------------------------------------------------------

async function assertPayer(tx: Tx, payerId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM payer WHERE id = ${payerId}::uuid LIMIT 1`;
  if (!rows[0]) throw new ValidationError("Unknown insurance plan. Pick one from the list.");
}

async function assertActiveMember(tx: Tx, orgId: string, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM org_member
     WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid AND status = 'active'
     LIMIT 1
  `;
  if (!rows[0]) throw new ValidationError("That person is not an active member of this organization.");
}

/** The practice's today, in its own zone. */
async function practiceToday(tx: Tx, orgId: string): Promise<string> {
  return orgToday(await readOrgTimeZone(tx, orgId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface RowShape {
  id: string;
  received_on: string;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  source_name: string | null;
  referring_provider_name: string | null;
  stage: ReferralStage;
  stage_changed_at: Date;
  stage_changed_on: string;
  days_open: number;
  requirements_open: bigint;
  requirements_total: number;
  latest_acuity: ReferralRow["latestAcuity"];
  triaged: boolean;
  verification: ReferralRow["verification"];
  payer_name: string | null;
  assigned_to_name: string | null;
  patient_id: string | null;
  ntuc_reason: string | null;
}

const toRow = (r: RowShape): ReferralRow => ({
  id: r.id,
  receivedOn: r.received_on,
  firstName: r.first_name,
  lastName: r.last_name,
  dateOfBirth: r.date_of_birth,
  sourceName: r.source_name,
  referringProviderName: r.referring_provider_name,
  stage: r.stage,
  stageChangedAt: r.stage_changed_at.toISOString(),
  stageChangedOn: r.stage_changed_on,
  daysOpen: Number(r.days_open),
  requirementsOpen: Number(r.requirements_open),
  requirementsTotal: Number(r.requirements_total),
  latestAcuity: r.latest_acuity,
  triaged: r.triaged,
  verification: r.verification,
  payerName: r.payer_name,
  assignedToName: r.assigned_to_name,
  patientId: r.patient_id,
  ntucReason: r.ntuc_reason,
});

export type ReferralFilter = "open" | "all" | ReferralStage;

export async function listReferrals(args: {
  orgId: string;
  filter?: ReferralFilter;
  q?: string;
  limit?: number;
}): Promise<ReferralRow[]> {
  const filter = args.filter ?? "open";
  const limit = Math.min(200, Math.max(1, args.limit ?? 100));
  const q = args.q?.trim() ? `%${args.q.trim().toLowerCase()}%` : null;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<RowShape[]>`
      SELECT r.id,
             to_char(r.received_on, 'YYYY-MM-DD') AS received_on,
             r.first_name, r.last_name,
             to_char(r.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
             r.source_name, r.referring_provider_name,
             r.stage, r.stage_changed_at,
             to_char((r.stage_changed_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS stage_changed_on,
             -- To the disposition, or to the practice's today while open.
             (COALESCE(
                CASE r.stage
                  WHEN 'admitted' THEN r.admitted_on
                  WHEN 'ntuc' THEN r.ntuc_on
                  WHEN 'transitioned' THEN (r.stage_changed_at AT TIME ZONE o.timezone)::date
                END,
                (now() AT TIME ZONE o.timezone)::date) - r.received_on)::int AS days_open,
             (SELECT count(*) FROM jsonb_array_elements(r.requirements) e
               WHERE e->>'doneAt' IS NULL) AS requirements_open,
             jsonb_array_length(r.requirements) AS requirements_total,
             t.preliminary_acuity AS latest_acuity,
             (t.id IS NOT NULL) AS triaged,
             v.result AS verification,
             pay.name AS payer_name,
             COALESCE(au.full_name, au.email) AS assigned_to_name,
             r.patient_id,
             CASE WHEN rc.id IS NULL THEN NULL ELSE rc.code || ' ' || rc.label END AS ntuc_reason
        FROM referral r
        JOIN org o ON o.id = r.org_id
        LEFT JOIN LATERAL (
          SELECT id, preliminary_acuity FROM referral_triage
           WHERE referral_id = r.id ORDER BY triaged_at DESC LIMIT 1
        ) t ON true
        LEFT JOIN LATERAL (
          SELECT result FROM insurance_verification
           WHERE referral_id = r.id ORDER BY verified_at DESC LIMIT 1
        ) v ON true
        LEFT JOIN payer pay ON pay.id = r.payer_id
        LEFT JOIN app_user au ON au.id = r.assigned_to_user_id
        LEFT JOIN org_reason_code rc ON rc.id = r.ntuc_reason_code_id
       WHERE r.org_id = ${args.orgId}::uuid
         AND (
           ${filter} = 'all'
           OR (${filter} = 'open' AND r.stage = ANY(${[...OPEN_STAGES]}::text[]))
           OR r.stage = ${filter}
         )
         AND (${q}::text IS NULL
              OR lower(r.first_name || ' ' || r.last_name) LIKE ${q}
              OR lower(COALESCE(r.source_name, '')) LIKE ${q})
       ORDER BY r.received_on DESC, r.created_at DESC
       LIMIT ${limit}
    `;
    return rows.map(toRow);
  });
}

export async function getReferralSummary(orgId: string): Promise<ReferralSummary> {
  return withOrgContext(orgId, async (tx) => {
    const today = await practiceToday(tx, orgId);
    // Open referrals whenever they came in; dispositions of the last year.
    const byStage = await tx.$queryRaw<{ stage: ReferralStage; n: bigint }[]>`
      SELECT stage, count(*)::bigint AS n
        FROM referral
       WHERE org_id = ${orgId}::uuid
         AND (stage = ANY(${[...OPEN_STAGES]}::text[])
              OR COALESCE(admitted_on, ntuc_on, stage_changed_at::date) > ${today}::date - 365)
       GROUP BY stage
    `;
    // The pipeline's conversion: of the referrals received in the window, how many
    // were admitted (its "admitted/received Total").
    const window = await tx.$queryRaw<{ received: bigint; admitted: bigint }[]>`
      SELECT count(*)::bigint AS received,
             count(*) FILTER (WHERE stage = 'admitted')::bigint AS admitted
        FROM referral
       WHERE org_id = ${orgId}::uuid
         AND received_on > ${today}::date - 365
    `;
    const counts = Object.fromEntries(REFERRAL_STAGES.map((s) => [s, 0])) as Record<ReferralStage, number>;
    for (const r of byStage) counts[r.stage] = Number(r.n);
    const received12m = Number(window[0]?.received ?? 0);
    const admitted12m = Number(window[0]?.admitted ?? 0);
    return {
      counts,
      received12m,
      admitted12m,
      conversion: received12m > 0 ? admitted12m / received12m : null,
    };
  });
}

interface DetailShape extends RowShape {
  phone: string | null;
  referring_provider_npi: string | null;
  reason: string | null;
  primary_diagnosis_icd10: string | null;
  payer_id: string | null;
  member_id: string | null;
  assigned_to_user_id: string | null;
  notes: string | null;
  requirements: ReferralRequirement[];
  ntuc_reason_code_id: string | null;
  ntuc_on: string | null;
  closed_note: string | null;
  admitted_on: string | null;
  created_by_name: string | null;
  created_at: Date;
  practice_today: string;
}

async function readTriage(tx: Tx, orgId: string, referralId: string): Promise<TriageView[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      symptoms: string | null;
      immediate_needs: string | null;
      preliminary_acuity: TriageView["preliminaryAcuity"];
      hospice_eligible: TriageView["hospiceEligible"];
      hospice_basis: string | null;
      triaged_by_name: string | null;
      triaged_at: Date;
    }[]
  >`
    SELECT t.id, t.symptoms, t.immediate_needs, t.preliminary_acuity, t.hospice_eligible,
           t.hospice_basis, COALESCE(u.full_name, u.email) AS triaged_by_name, t.triaged_at
      FROM referral_triage t
      LEFT JOIN app_user u ON u.id = t.triaged_by_user_id
     WHERE t.org_id = ${orgId}::uuid AND t.referral_id = ${referralId}::uuid
     ORDER BY t.triaged_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    symptoms: r.symptoms,
    immediateNeeds: r.immediate_needs,
    preliminaryAcuity: r.preliminary_acuity,
    hospiceEligible: r.hospice_eligible,
    hospiceBasis: r.hospice_basis,
    triagedByName: r.triaged_by_name,
    triagedAt: r.triaged_at.toISOString(),
  }));
}

async function readVerifications(
  tx: Tx,
  orgId: string,
  subject: { referralId: string } | { patientId: string },
): Promise<VerificationView[]> {
  const referralId = "referralId" in subject ? subject.referralId : null;
  const patientId = "patientId" in subject ? subject.patientId : null;
  const rows = await tx.$queryRaw<
    {
      id: string;
      payer_id: string | null;
      payer_name: string | null;
      member_id: string | null;
      method: VerificationView["method"];
      result: VerificationView["result"];
      coverage_effective_on: string | null;
      coverage_ends_on: string | null;
      reference: string | null;
      notes: string | null;
      verified_by_name: string | null;
      verified_at: Date;
      details: VerificationView["details"];
    }[]
  >`
    SELECT v.id, v.payer_id, pay.name AS payer_name, v.member_id, v.method, v.result,
           to_char(v.coverage_effective_on, 'YYYY-MM-DD') AS coverage_effective_on,
           to_char(v.coverage_ends_on, 'YYYY-MM-DD') AS coverage_ends_on,
           v.reference, v.notes, COALESCE(u.full_name, u.email) AS verified_by_name, v.verified_at, v.details
      FROM insurance_verification v
      LEFT JOIN payer pay ON pay.id = v.payer_id
      LEFT JOIN app_user u ON u.id = v.verified_by_user_id
     WHERE v.org_id = ${orgId}::uuid
       AND (${referralId}::uuid IS NULL OR v.referral_id = ${referralId}::uuid)
       AND (${patientId}::uuid IS NULL OR v.patient_id = ${patientId}::uuid)
     ORDER BY v.verified_at DESC
     LIMIT 50
  `;
  return rows.map((r) => ({
    id: r.id,
    payerId: r.payer_id,
    payerName: r.payer_name,
    memberId: r.member_id,
    method: r.method,
    result: r.result,
    coverageEffectiveOn: r.coverage_effective_on,
    coverageEndsOn: r.coverage_ends_on,
    reference: r.reference,
    notes: r.notes,
    verifiedByName: r.verified_by_name,
    verifiedAt: r.verified_at.toISOString(),
    details: r.details ?? null,
  }));
}

export async function getReferral(args: { orgId: string; id: string }): Promise<ReferralView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<DetailShape[]>`
      SELECT r.id,
             to_char(r.received_on, 'YYYY-MM-DD') AS received_on,
             r.first_name, r.last_name,
             to_char(r.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
             r.source_name, r.referring_provider_name, r.stage, r.stage_changed_at,
             to_char((r.stage_changed_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS stage_changed_on,
             (COALESCE(
                CASE r.stage
                  WHEN 'admitted' THEN r.admitted_on
                  WHEN 'ntuc' THEN r.ntuc_on
                  WHEN 'transitioned' THEN (r.stage_changed_at AT TIME ZONE o.timezone)::date
                END,
                (now() AT TIME ZONE o.timezone)::date) - r.received_on)::int AS days_open,
             (SELECT count(*) FROM jsonb_array_elements(r.requirements) e
               WHERE e->>'doneAt' IS NULL) AS requirements_open,
             jsonb_array_length(r.requirements) AS requirements_total,
             (SELECT preliminary_acuity FROM referral_triage
               WHERE referral_id = r.id ORDER BY triaged_at DESC LIMIT 1) AS latest_acuity,
             EXISTS (SELECT 1 FROM referral_triage WHERE referral_id = r.id) AS triaged,
             (SELECT result FROM insurance_verification
               WHERE referral_id = r.id ORDER BY verified_at DESC LIMIT 1) AS verification,
             pay.name AS payer_name,
             COALESCE(au.full_name, au.email) AS assigned_to_name,
             r.patient_id,
             CASE WHEN rc.id IS NULL THEN NULL ELSE rc.code || ' ' || rc.label END AS ntuc_reason,
             r.phone, r.referring_provider_npi, r.reason, r.primary_diagnosis_icd10,
             r.payer_id, r.member_id, r.assigned_to_user_id, r.notes, r.requirements,
             r.ntuc_reason_code_id, to_char(r.ntuc_on, 'YYYY-MM-DD') AS ntuc_on, r.closed_note,
             to_char(r.admitted_on, 'YYYY-MM-DD') AS admitted_on,
             COALESCE(cu.full_name, cu.email) AS created_by_name, r.created_at,
             to_char((now() AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS practice_today
        FROM referral r
        JOIN org o ON o.id = r.org_id
        LEFT JOIN payer pay ON pay.id = r.payer_id
        LEFT JOIN app_user au ON au.id = r.assigned_to_user_id
        LEFT JOIN app_user cu ON cu.id = r.created_by_user_id
        LEFT JOIN org_reason_code rc ON rc.id = r.ntuc_reason_code_id
       WHERE r.id = ${args.id}::uuid AND r.org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      ...toRow(r),
      phone: r.phone,
      referringProviderNpi: r.referring_provider_npi,
      reason: r.reason,
      primaryDiagnosisIcd10: r.primary_diagnosis_icd10,
      payerId: r.payer_id,
      memberId: r.member_id,
      assignedToUserId: r.assigned_to_user_id,
      notes: r.notes,
      requirements: Array.isArray(r.requirements) ? r.requirements : [],
      ntucReasonCodeId: r.ntuc_reason_code_id,
      ntucOn: r.ntuc_on,
      closedNote: r.closed_note,
      admittedOn: r.admitted_on,
      createdByName: r.created_by_name,
      createdAt: r.created_at.toISOString(),
      triage: await readTriage(tx, args.orgId, r.id),
      verifications: await readVerifications(tx, args.orgId, { referralId: r.id }),
      practiceToday: r.practice_today,
    };
  });
}

/** The practice's today, for the day a new referral starts on. */
export async function referralToday(orgId: string): Promise<string> {
  return withOrgContext(orgId, (tx) => practiceToday(tx, orgId));
}

export async function listPatientVerifications(args: {
  orgId: string;
  patientId: string;
}): Promise<VerificationView[]> {
  return withOrgContext(args.orgId, (tx) => readVerifications(tx, args.orgId, { patientId: args.patientId }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createReferral(args: {
  orgId: string;
  userId: string;
  payload: CreateReferral;
}): Promise<{ id: string }> {
  const p = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const today = await practiceToday(tx, args.orgId);
    if (p.receivedOn > today) throw new ValidationError("A referral cannot be received after today.");
    if (p.dateOfBirth && p.dateOfBirth > today) throw new ValidationError("The date of birth is after today.");
    if (p.payerId) await assertPayer(tx, p.payerId);
    if (p.assignedToUserId) await assertActiveMember(tx, args.orgId, p.assignedToUserId);
    const phi = await applyPhiKeyIfConfigured(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO referral (
        org_id, received_on, first_name, last_name, date_of_birth, phone,
        source_name, referring_provider_name, referring_provider_npi, reason,
        primary_diagnosis_icd10, payer_id, member_id, member_id_enc,
        assigned_to_user_id, notes, created_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${p.receivedOn}::date, ${p.firstName}, ${p.lastName},
        ${p.dateOfBirth ?? null}::date, ${p.phone ?? null},
        ${p.sourceName ?? null}, ${p.referringProviderName || null}, ${p.referringProviderNpi ?? null},
        ${p.reason || null}, ${p.primaryDiagnosisIcd10 ?? null},
        ${p.payerId ?? null}::uuid, ${p.memberId ?? null},
        CASE WHEN ${phi} THEN encrypt_phi(${p.memberId ?? null}) ELSE NULL END,
        ${p.assignedToUserId ?? null}::uuid, ${p.notes || null}, ${args.userId}::uuid
      )
      RETURNING id
    `;
    const id = rows[0]!.id;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "referral_create",
      targetType: "referral",
      targetId: id,
      payload: { hasSource: Boolean(p.sourceName), hasInsurance: Boolean(p.payerId) },
    });
    return { id };
  });
}

/** Columns an update writes, by payload key, for the audit's field names. */
const UPDATE_COLUMNS: Record<keyof UpdateReferral, string> = {
  receivedOn: "received_on",
  firstName: "first_name",
  lastName: "last_name",
  dateOfBirth: "date_of_birth",
  phone: "phone",
  sourceName: "source_name",
  referringProviderName: "referring_provider_name",
  referringProviderNpi: "referring_provider_npi",
  reason: "reason",
  primaryDiagnosisIcd10: "primary_diagnosis_icd10",
  payerId: "payer_id",
  memberId: "member_id",
  assignedToUserId: "assigned_to_user_id",
  notes: "notes",
};

const sent = (v: unknown) => v !== undefined;

export async function updateReferral(args: {
  orgId: string;
  userId: string;
  id: string;
  payload: UpdateReferral;
}): Promise<{ updated: boolean }> {
  const p = args.payload;
  const fields = (Object.keys(UPDATE_COLUMNS) as (keyof UpdateReferral)[]).filter((k) => sent(p[k]));
  if (fields.length === 0) return { updated: false };
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ stage: ReferralStage }[]>`
      SELECT stage FROM referral WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Referral not found.");
    if (cur[0].stage === "admitted") {
      throw new ValidationError("This referral was admitted. Correct the patient's chart instead.");
    }
    const today = await practiceToday(tx, args.orgId);
    if (p.receivedOn && p.receivedOn > today) throw new ValidationError("A referral cannot be received after today.");
    if (p.dateOfBirth && p.dateOfBirth > today) throw new ValidationError("The date of birth is after today.");
    if (p.payerId) await assertPayer(tx, p.payerId);
    if (p.assignedToUserId) await assertActiveMember(tx, args.orgId, p.assignedToUserId);
    const phi = await applyPhiKeyIfConfigured(tx);
    await tx.$executeRaw`
      UPDATE referral SET
        received_on = COALESCE(${p.receivedOn ?? null}::date, received_on),
        first_name  = COALESCE(${p.firstName ?? null}, first_name),
        last_name   = COALESCE(${p.lastName ?? null}, last_name),
        date_of_birth = CASE WHEN ${sent(p.dateOfBirth)} THEN ${p.dateOfBirth ?? null}::date ELSE date_of_birth END,
        phone       = CASE WHEN ${sent(p.phone)} THEN ${p.phone ?? null} ELSE phone END,
        source_name = CASE WHEN ${sent(p.sourceName)} THEN ${p.sourceName ?? null} ELSE source_name END,
        referring_provider_name = CASE WHEN ${sent(p.referringProviderName)} THEN ${p.referringProviderName || null} ELSE referring_provider_name END,
        referring_provider_npi  = CASE WHEN ${sent(p.referringProviderNpi)} THEN ${p.referringProviderNpi ?? null} ELSE referring_provider_npi END,
        reason      = CASE WHEN ${sent(p.reason)} THEN ${p.reason || null} ELSE reason END,
        primary_diagnosis_icd10 = CASE WHEN ${sent(p.primaryDiagnosisIcd10)} THEN ${p.primaryDiagnosisIcd10 ?? null} ELSE primary_diagnosis_icd10 END,
        payer_id    = CASE WHEN ${sent(p.payerId)} THEN ${p.payerId ?? null}::uuid ELSE payer_id END,
        member_id   = CASE WHEN ${sent(p.memberId)} THEN ${p.memberId ?? null} ELSE member_id END,
        -- Mirrors the plaintext, as on the patient: never a stale ciphertext.
        member_id_enc = CASE
          WHEN NOT ${sent(p.memberId)} THEN member_id_enc
          WHEN ${p.memberId ?? null}::text IS NOT NULL AND ${phi} THEN encrypt_phi(${p.memberId ?? null})
          ELSE NULL
        END,
        assigned_to_user_id = CASE WHEN ${sent(p.assignedToUserId)} THEN ${p.assignedToUserId ?? null}::uuid ELSE assigned_to_user_id END,
        notes       = CASE WHEN ${sent(p.notes)} THEN ${p.notes || null} ELSE notes END,
        updated_at  = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "referral_update",
      targetType: "referral",
      targetId: args.id,
      payload: { fields: fields.map((f) => UPDATE_COLUMNS[f]) },
    });
    return { updated: true };
  });
}

/**
 * Replace the pending-requirements checklist. An item ticked now is stamped
 * with now and the person ticking it; one ticked before keeps its stamp; an
 * unticked one loses it.
 */
export async function setReferralRequirements(args: {
  orgId: string;
  userId: string;
  id: string;
  items: { id: string; label: string; done: boolean }[];
}): Promise<ReferralRequirement[]> {
  const ids = new Set(args.items.map((i) => i.id));
  if (ids.size !== args.items.length) throw new ValidationError("A requirement is listed twice.");
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ stage: ReferralStage; requirements: ReferralRequirement[] }[]>`
      SELECT stage, requirements FROM referral
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Referral not found.");
    if (!isOpenStage(cur[0].stage)) {
      throw new ValidationError("This referral is closed. Reopen it to change its requirements.");
    }
    const before = new Map((cur[0].requirements ?? []).map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const next: ReferralRequirement[] = args.items.map((i) => {
      const prev = before.get(i.id);
      return {
        id: i.id,
        label: i.label.trim(),
        doneAt: i.done ? (prev?.doneAt ?? now) : null,
        doneBy: i.done ? (prev?.doneBy ?? args.userId) : null,
      };
    });
    await tx.$executeRaw`
      UPDATE referral SET requirements = ${JSON.stringify(next)}::jsonb, updated_at = now()
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "referral_requirements",
      targetType: "referral",
      targetId: args.id,
      payload: { done: next.filter((r) => r.doneAt).length, total: next.length },
    });
    return next;
  });
}

/** A stage move from the board: NTUC, set aside, transitioned, or reopened. */
export async function changeReferralStage(args: {
  orgId: string;
  userId: string;
  id: string;
  change: StageChange;
}): Promise<{ from: ReferralStage; to: ReferralStage }> {
  const c = args.change;
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ stage: ReferralStage; received_on: string }[]>`
      SELECT stage, to_char(received_on, 'YYYY-MM-DD') AS received_on FROM referral
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid FOR UPDATE
    `;
    if (!cur[0]) throw new NotFoundError("Referral not found.");
    const from = cur[0].stage;
    if (!stageMovesFrom(from).includes(c.to)) {
      throw new ValidationError(
        from === "admitted"
          ? "This referral was admitted; it has a chart now."
          : `A referral cannot move from ${from.replace(/_/g, " ")} to ${c.to.replace(/_/g, " ")}.`,
      );
    }
    let reasonCode: string | null = null;
    if (c.to === "ntuc") {
      await ensureReasonCodes(tx, args.orgId);
      const code = await tx.$queryRaw<{ code: string }[]>`
        SELECT code FROM org_reason_code
         WHERE id = ${c.reasonCodeId}::uuid AND org_id = ${args.orgId}::uuid
           AND kind = 'ntuc' AND active
         LIMIT 1
      `;
      if (!code[0]) throw new ValidationError("Pick one of the practice's NTUC reasons.");
      reasonCode = code[0].code;
      const today = await practiceToday(tx, args.orgId);
      if (c.on > today) throw new ValidationError("The NTUC day is after today.");
      if (c.on < cur[0].received_on) throw new ValidationError("The NTUC day is before the referral was received.");
    }
    await tx.$executeRaw`
      UPDATE referral SET
        stage = ${c.to},
        stage_changed_at = now(),
        ntuc_reason_code_id = ${c.to === "ntuc" ? c.reasonCodeId : null}::uuid,
        ntuc_on = ${c.to === "ntuc" ? c.on : null}::date,
        -- A reopened referral starts its note over; any other move records its own.
        closed_note = ${c.note?.trim() || null},
        updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "referral_stage",
      targetType: "referral",
      targetId: args.id,
      payload: { from, to: c.to, reasonCode },
    });
    return { from, to: c.to };
  });
}

/** The acuity the referral's latest triage gave: what admission may carry over. */
export async function referralTriageAcuity(args: { orgId: string; referralId: string }): Promise<string | null> {
  const rows = await withOrgContext(args.orgId, (tx) =>
    tx.$queryRaw<{ preliminary_acuity: string | null }[]>`
      SELECT preliminary_acuity FROM referral_triage
       WHERE referral_id = ${args.referralId}::uuid AND org_id = ${args.orgId}::uuid
       ORDER BY triaged_at DESC LIMIT 1
    `,
  );
  return rows[0]?.preliminary_acuity ?? null;
}

export async function addReferralTriage(args: {
  orgId: string;
  userId: string;
  referralId: string;
  payload: Triage;
}): Promise<{ id: string }> {
  const t = args.payload;
  return withOrgContext(args.orgId, async (tx) => {
    const cur = await tx.$queryRaw<{ stage: ReferralStage }[]>`
      SELECT stage FROM referral WHERE id = ${args.referralId}::uuid AND org_id = ${args.orgId}::uuid
    `;
    if (!cur[0]) throw new NotFoundError("Referral not found.");
    if (!isOpenStage(cur[0].stage)) {
      throw new ValidationError("Triage is recorded before admission. This referral is closed.");
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO referral_triage (
        org_id, referral_id, symptoms, immediate_needs, preliminary_acuity,
        hospice_eligible, hospice_basis, triaged_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${args.referralId}::uuid, ${t.symptoms || null}, ${t.immediateNeeds || null},
        ${t.preliminaryAcuity ?? null}, ${t.hospiceEligible ?? null}, ${t.hospiceBasis || null},
        ${args.userId}::uuid
      )
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "referral_triage",
      targetType: "referral",
      targetId: args.referralId,
      payload: { triageId: rows[0]!.id },
    });
    return { id: rows[0]!.id };
  });
}

/** One check of coverage, for a referral or for a patient (doc:23). */
export async function addInsuranceVerification(args: {
  orgId: string;
  userId: string;
  subject: { referralId: string } | { patientId: string };
  payload: Verification;
}): Promise<{ id: string }> {
  const v = args.payload;
  const referralId = "referralId" in args.subject ? args.subject.referralId : null;
  let patientId = "patientId" in args.subject ? args.subject.patientId : null;
  return withOrgContext(args.orgId, async (tx) => {
    if (referralId) {
      const r = await tx.$queryRaw<{ stage: ReferralStage; patient_id: string | null }[]>`
        SELECT stage, patient_id FROM referral WHERE id = ${referralId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      if (!r[0]) throw new NotFoundError("Referral not found.");
      if (r[0].stage === "ntuc" || r[0].stage === "transitioned") {
        throw new ValidationError("This referral is closed. Reopen it to record a coverage check.");
      }
      // Admitted: the check belongs on the chart too, or the chart never shows
      // it (admission moved the earlier ones over; this one came after).
      patientId = r[0].patient_id;
    } else {
      const r = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM patient WHERE id = ${patientId}::uuid AND org_id = ${args.orgId}::uuid
      `;
      if (!r[0]) throw new NotFoundError("Patient not found.");
    }
    if (v.payerId) await assertPayer(tx, v.payerId);
    const phi = await applyPhiKeyIfConfigured(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO insurance_verification (
        org_id, referral_id, patient_id, payer_id, member_id, member_id_enc,
        method, result, coverage_effective_on, coverage_ends_on, reference, notes,
        verified_by_user_id
      ) VALUES (
        ${args.orgId}::uuid, ${referralId}::uuid, ${patientId}::uuid, ${v.payerId ?? null}::uuid,
        ${v.memberId ?? null}, CASE WHEN ${phi} THEN encrypt_phi(${v.memberId ?? null}) ELSE NULL END,
        ${v.method}, ${v.result}, ${v.coverageEffectiveOn ?? null}::date, ${v.coverageEndsOn ?? null}::date,
        ${v.reference || null}, ${v.notes || null}, ${args.userId}::uuid
      )
      RETURNING id
    `;
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId,
      action: "insurance_verification",
      targetType: referralId ? "referral" : "patient",
      targetId: referralId ?? patientId,
      payload: {
        subject: referralId ? "referral" : "patient",
        method: v.method,
        result: v.result,
        ...(referralId && patientId ? { patientId } : {}),
      },
    });
    return { id: rows[0]!.id };
  });
}

/**
 * Admission (doc:25): the intake wizard has just created the patient, in this
 * transaction. The referral becomes admitted on the practice's today and
 * names the patient; its coverage checks follow the person onto the chart.
 * A referral already admitted or closed refuses, and the patient it was about
 * to become is rolled back with it.
 */
export async function admitReferralInTx(
  tx: Tx,
  args: { orgId: string; referralId: string; patientId: string; userId: string },
): Promise<void> {
  const cur = await tx.$queryRaw<{ stage: ReferralStage; patient_id: string | null }[]>`
    SELECT stage, patient_id FROM referral
     WHERE id = ${args.referralId}::uuid AND org_id = ${args.orgId}::uuid FOR UPDATE
  `;
  if (!cur[0]) throw new ValidationError("That referral is not this practice's.");
  if (!isOpenStage(cur[0].stage) || cur[0].patient_id) {
    throw new ValidationError(
      cur[0].stage === "admitted"
        ? "This referral was already admitted."
        : "This referral is closed. Reopen it before admitting.",
    );
  }
  const today = await practiceToday(tx, args.orgId);
  await tx.$executeRaw`
    UPDATE referral SET
      stage = 'admitted', stage_changed_at = now(), admitted_on = ${today}::date,
      patient_id = ${args.patientId}::uuid, updated_at = now()
    WHERE id = ${args.referralId}::uuid AND org_id = ${args.orgId}::uuid
  `;
  await tx.$executeRaw`
    UPDATE insurance_verification SET patient_id = ${args.patientId}::uuid
     WHERE referral_id = ${args.referralId}::uuid AND org_id = ${args.orgId}::uuid AND patient_id IS NULL
  `;
  // And its paperwork (0112, Mark Q11j): kept on the patient from now on.
  await moveReferralDocumentsToPatient(tx, args);
  await writeAudit(tx, {
    orgId: args.orgId,
    userId: args.userId,
    action: "referral_stage",
    targetType: "referral",
    targetId: args.referralId,
    payload: { from: cur[0].stage, to: "admitted", patientId: args.patientId },
  });
}
