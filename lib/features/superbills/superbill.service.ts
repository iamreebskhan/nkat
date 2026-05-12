/**
 * Superbill service — Prisma I/O against the `superbill` table.
 *
 * The flow:
 *   1. `buildDraftFromVisit()` — read visit + patient + clinician,
 *      hand-off to the pure `buildSuperbill()` to build the draft.
 *   2. `persistDraft()` — write a `draft` row + return its id.
 *   3. `markStatus()` — billing agent transitions through draft →
 *      ready_to_submit → submitted → paid|partially_paid|denied|voided.
 */
import { withOrgContext } from "@/lib/db";
import { buildSuperbill, type DraftSuperbill, type ProviderTier } from "./superbill-pure";

export const SUPERBILL_STATUSES = [
  "draft",
  "ready_to_submit",
  "submitted",
  "paid",
  "partially_paid",
  "denied",
  "voided",
] as const;
export type SuperbillStatus = (typeof SUPERBILL_STATUSES)[number];

interface VisitForSuperbill {
  id: string;
  patient_id: string;
  is_telehealth: boolean;
  cpt_codes_assigned: string[] | null;
  icd10_codes: string[] | null;
  modifiers: string[] | null;
  scheduled_start: Date | null;
  start_time: Date | null;
  primary_payer_id: string | null;
  primary_member_id: string | null;
  npi: string | null;
  full_name: string | null;
}

/**
 * Read the joined data needed to build a draft superbill. The clinician
 * tier (MD vs NP/PA) is inferred from the user's NPI taxonomy in a
 * follow-up phase; for now we default to NP/PA which is the palliative
 * majority case + the more conservative reimbursement estimate.
 */
export async function buildDraftFromVisit(args: {
  orgId: string;
  visitId: string;
  /** Override: when known (e.g. from the user's profile), pass directly. */
  providerTier?: ProviderTier;
}): Promise<DraftSuperbill> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<VisitForSuperbill[]>`
      SELECT v.id, v.patient_id, v.is_telehealth,
             v.cpt_codes_assigned, v.icd10_codes, v.modifiers,
             v.scheduled_start, v.start_time,
             p.primary_payer_id, p.primary_member_id,
             u.npi, u.full_name
      FROM visit v
      JOIN patient p ON p.id = v.patient_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      WHERE v.id = ${args.visitId}::uuid
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) throw new Error("buildDraftFromVisit: visit not found");

    const dosDate = r.start_time ?? r.scheduled_start ?? new Date();

    return buildSuperbill({
      visit: {
        id: r.id,
        patientId: r.patient_id,
        isTelehealth: r.is_telehealth,
        cptCodesAssigned: r.cpt_codes_assigned ?? [],
        icd10Codes: r.icd10_codes ?? [],
        modifiers: r.modifiers ?? [],
        dos: dosDate.toISOString().slice(0, 10),
      },
      patient: {
        id: r.patient_id,
        primaryPayerId: r.primary_payer_id,
        primaryMemberId: r.primary_member_id,
      },
      provider: {
        npi: r.npi ?? "",
        fullName: r.full_name ?? "",
        tier: args.providerTier ?? "NP_PA",
      },
    });
  });
}

/**
 * Persist the draft as a `superbill` row. Idempotent — second call for
 * the same visit returns the existing id (visit_id is UNIQUE).
 */
export async function persistDraft(args: {
  orgId: string;
  draft: DraftSuperbill;
}): Promise<{ id: string }> {
  const { orgId, draft } = args;
  return withOrgContext(orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO superbill (
        org_id, visit_id, patient_id, payer_id,
        member_id_snapshot, date_of_service,
        cpt_codes, icd10_codes, modifiers,
        provider_npi, provider_name, place_of_service_code,
        billed_amount_cents, status
      ) VALUES (
        ${orgId}::uuid, ${draft.visitId}::uuid, ${draft.patientId}::uuid,
        ${draft.payerId ?? null}::uuid,
        ${draft.memberIdSnapshot}, ${draft.dateOfService}::date,
        ${draft.cptCodes}::text[], ${draft.icd10Codes}::text[], ${draft.modifiers}::text[],
        ${draft.providerNpi}, ${draft.providerName}, ${draft.placeOfServiceCode},
        ${draft.billedAmountCents}, 'draft'
      )
      ON CONFLICT (visit_id) DO UPDATE SET
        cpt_codes = EXCLUDED.cpt_codes,
        icd10_codes = EXCLUDED.icd10_codes,
        modifiers = EXCLUDED.modifiers,
        billed_amount_cents = EXCLUDED.billed_amount_cents,
        updated_at = now()
      RETURNING id
    `;
    return { id: rows[0]!.id };
  });
}

export interface SuperbillView {
  id: string;
  visitId: string;
  patientId: string;
  payerId: string | null;
  memberIdSnapshot: string;
  dateOfService: string;
  cptCodes: string[];
  icd10Codes: string[];
  modifiers: string[];
  providerNpi: string;
  providerName: string;
  placeOfServiceCode: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
  status: SuperbillStatus;
  submittedAt: string | null;
  paidAt: string | null;
  generatedPdfPath: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SuperbillRow {
  id: string;
  visit_id: string;
  patient_id: string;
  payer_id: string | null;
  member_id_snapshot: string;
  date_of_service: Date;
  cpt_codes: string[];
  icd10_codes: string[];
  modifiers: string[];
  provider_npi: string;
  provider_name: string;
  place_of_service_code: string;
  billed_amount_cents: number;
  paid_amount_cents: number | null;
  status: SuperbillStatus;
  submitted_at: Date | null;
  paid_at: Date | null;
  generated_pdf_path: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToView(r: SuperbillRow): SuperbillView {
  return {
    id: r.id,
    visitId: r.visit_id,
    patientId: r.patient_id,
    payerId: r.payer_id,
    memberIdSnapshot: r.member_id_snapshot,
    dateOfService: r.date_of_service.toISOString().slice(0, 10),
    cptCodes: r.cpt_codes,
    icd10Codes: r.icd10_codes,
    modifiers: r.modifiers ?? [],
    providerNpi: r.provider_npi,
    providerName: r.provider_name,
    placeOfServiceCode: r.place_of_service_code,
    billedAmountCents: Number(r.billed_amount_cents),
    paidAmountCents: r.paid_amount_cents ? Number(r.paid_amount_cents) : null,
    status: r.status,
    submittedAt: r.submitted_at?.toISOString() ?? null,
    paidAt: r.paid_at?.toISOString() ?? null,
    generatedPdfPath: r.generated_pdf_path,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function getSuperbillByVisit(args: {
  orgId: string;
  visitId: string;
}): Promise<SuperbillView | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<SuperbillRow[]>`
      SELECT * FROM superbill WHERE visit_id = ${args.visitId}::uuid LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

export async function listSuperbills(args: {
  orgId: string;
  status?: SuperbillStatus;
  limit?: number;
}): Promise<SuperbillView[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<SuperbillRow[]>`
      SELECT * FROM superbill
      WHERE (${args.status ?? null}::text IS NULL OR status = ${args.status ?? null})
      ORDER BY date_of_service DESC, created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToView);
  });
}

export async function markStatus(args: {
  orgId: string;
  id: string;
  to: SuperbillStatus;
  paidAmountCents?: number;
}): Promise<void> {
  await withOrgContext(args.orgId, async (tx) => {
    if (args.to === "submitted") {
      await tx.$executeRaw`
        UPDATE superbill SET status = 'submitted', submitted_at = now(), updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
    } else if (args.to === "paid" || args.to === "partially_paid") {
      await tx.$executeRaw`
        UPDATE superbill SET
          status = ${args.to},
          paid_at = now(),
          paid_amount_cents = ${args.paidAmountCents ?? null},
          updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
    } else {
      await tx.$executeRaw`
        UPDATE superbill SET status = ${args.to}, updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
    }
  });
}
