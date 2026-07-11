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
import { NotFoundError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { predictSuperbill } from "@/lib/features/billing/predict-superbill.service";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";
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
    // NOTE: rendering-provider NPI is intentionally NOT pulled from
    // app_user — that column doesn't exist in the live schema (the
    // Prisma model is out of sync). For solo-practice orgs we fall
    // back to org.npi captured during onboarding; multi-clinician
    // orgs will need a clinician_profile.npi column in a follow-up.
    const rows = await tx.$queryRaw<VisitForSuperbill[]>`
      SELECT v.id, v.patient_id, v.is_telehealth,
             v.cpt_codes_assigned, v.icd10_codes, v.modifiers,
             v.scheduled_start, v.start_time,
             p.primary_payer_id, p.primary_member_id,
             COALESCE(ob.npi, '') AS npi,
             u.full_name
      FROM visit v
      JOIN patient p ON p.id = v.patient_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      LEFT JOIN onboarding_status ob ON ob.org_id = v.org_id
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

  // Phase B — capture the predictor result at save-time. Best-effort:
  // if predict fails (e.g. payer rules missing) we persist with NULL
  // and the nightly feedback cron just skips this row.
  let predictedRisk: unknown = null;
  try {
    predictedRisk = await predictSuperbill({
      orgId,
      payerId: draft.payerId,
      state: null, // patient state isn't on the draft; the picker
      // path will pass it on update — for first-save we leave null
      // and the scorer flags coverage_unknown until edits provide it.
      patientId: draft.patientId,
      dos: draft.dateOfService,
      cptCodes: draft.cptCodes,
      modifiers: draft.modifiers,
      icd10Codes: draft.icd10Codes,
    });
  } catch {
    /* keep NULL */
  }

  return withOrgContext(orgId, async (tx) => {
    // PHI dual-write (0034): _enc companion when PALLIO_PHI_KEY is set.
    const phi = await applyPhiKeyIfConfigured(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO superbill (
        org_id, visit_id, patient_id, payer_id,
        member_id_snapshot, member_id_snapshot_enc, date_of_service,
        cpt_codes, icd10_codes, modifiers,
        provider_npi, provider_name, place_of_service_code,
        billed_amount_cents, status, predicted_risk
      ) VALUES (
        ${orgId}::uuid, ${draft.visitId}::uuid, ${draft.patientId}::uuid,
        ${draft.payerId ?? null}::uuid,
        ${draft.memberIdSnapshot},
        CASE WHEN ${phi} THEN encrypt_phi(${draft.memberIdSnapshot}) ELSE NULL END,
        ${draft.dateOfService}::date,
        ${draft.cptCodes}::text[], ${draft.icd10Codes}::text[], ${draft.modifiers}::text[],
        ${draft.providerNpi}, ${draft.providerName}, ${draft.placeOfServiceCode},
        ${draft.billedAmountCents}, 'draft',
        ${predictedRisk ? JSON.stringify(predictedRisk) : null}::jsonb
      )
      ON CONFLICT (visit_id) DO UPDATE SET
        cpt_codes = EXCLUDED.cpt_codes,
        icd10_codes = EXCLUDED.icd10_codes,
        modifiers = EXCLUDED.modifiers,
        billed_amount_cents = EXCLUDED.billed_amount_cents,
        predicted_risk = COALESCE(EXCLUDED.predicted_risk, superbill.predicted_risk),
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
  /** Phase B — predictor output captured at save-time. */
  predictedRisk: unknown | null;
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
  predicted_risk: unknown | null;
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
    predictedRisk: r.predicted_risk,
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

/**
 * Edit a draft superbill (Phase A — payer-scoped picker).
 *
 * Lets the nurse change the CPT / ICD-10 / modifier sets on a saved
 * draft before they advance the status. Each call also takes an
 * `overrides` array — when the nurse picks a code that wasn't on the
 * payer's allow-list, the UI passes it here so we can write an
 * `audit_log` row of type `superbill_code_override` for compliance.
 *
 * RLS-scoped via withOrgContext; status is intentionally NOT writable
 * through this path (use markStatus for transitions).
 */
export async function updateSuperbill(args: {
  orgId: string;
  id: string;
  userId: string;
  patch: {
    cptCodes?: string[];
    icd10Codes?: string[];
    modifiers?: string[];
  };
  overrides?: Array<{ code: string; reason: string }>;
}): Promise<{ updated: boolean }> {
  return withOrgContext(args.orgId, async (tx) => {
    const exists = await tx.$queryRaw<{ id: string; status: SuperbillStatus }[]>`
      SELECT id, status FROM superbill WHERE id = ${args.id}::uuid LIMIT 1
    `;
    if (!exists[0]) throw new Error("Superbill not found.");
    if (exists[0].status !== "draft") {
      throw new Error(
        `Superbill is ${exists[0].status}; only drafts can be edited.`,
      );
    }

    let touched = false;
    if (args.patch.cptCodes) {
      await tx.$executeRaw`
        UPDATE superbill SET cpt_codes = ${args.patch.cptCodes}::text[], updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    if (args.patch.icd10Codes) {
      await tx.$executeRaw`
        UPDATE superbill SET icd10_codes = ${args.patch.icd10Codes}::text[], updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }
    if (args.patch.modifiers) {
      await tx.$executeRaw`
        UPDATE superbill SET modifiers = ${args.patch.modifiers}::text[], updated_at = now()
        WHERE id = ${args.id}::uuid
      `;
      touched = true;
    }

    if (args.overrides && args.overrides.length > 0) {
      for (const o of args.overrides) {
        await tx.$executeRaw`
          INSERT INTO audit_log (
            org_id, user_id, action, target_type, target_id, payload
          ) VALUES (
            ${args.orgId}::uuid, ${args.userId}::uuid,
            'superbill_code_override', 'superbill', ${args.id}::uuid,
            ${JSON.stringify({ code: o.code, reason: o.reason })}::jsonb
          )
        `;
      }
    }

    return { updated: touched };
  }).then(async (result) => {
    // Phase B — recapture predicted_risk after the nurse's edits so the
    // stored prediction reflects the codes actually on the bill (the
    // feedback loop compares THIS against the real denial). Best-effort:
    // a predictor failure must not fail the edit. Runs after the edit tx
    // commits so predictSuperbill's own context sees the new codes.
    if (!result.updated) return result;
    try {
      const ctx = await withOrgContext(args.orgId, async (tx) =>
        tx.$queryRaw<
          { payer_id: string | null; patient_id: string; dos: Date; state: string | null; cpt: string[]; mods: string[] }[]
        >`
          SELECT s.payer_id, s.patient_id, s.date_of_service AS dos,
                 p.state, s.cpt_codes AS cpt, s.modifiers AS mods
            FROM superbill s JOIN patient p ON p.id = s.patient_id
           WHERE s.id = ${args.id}::uuid LIMIT 1
        `,
      );
      const c = ctx[0];
      if (c) {
        const risk = await predictSuperbill({
          orgId: args.orgId,
          payerId: c.payer_id,
          state: c.state,
          patientId: c.patient_id,
          dos: c.dos.toISOString().slice(0, 10),
          cptCodes: c.cpt ?? [],
          modifiers: c.mods ?? [],
        });
        await withOrgContext(args.orgId, async (tx) => {
          await tx.$executeRaw`
            UPDATE superbill SET predicted_risk = ${JSON.stringify(risk)}::jsonb, updated_at = now()
             WHERE id = ${args.id}::uuid
          `;
        });
      }
    } catch (e) {
      console.warn("predicted_risk recapture failed (non-fatal):", e);
    }
    return result;
  });
}

/** Legal status moves — mirrors the lifecycle documented in the header. */
const STATUS_TRANSITIONS: Record<SuperbillStatus, SuperbillStatus[]> = {
  draft: ["ready_to_submit", "submitted", "voided"],
  ready_to_submit: ["submitted", "draft", "voided"],
  submitted: ["paid", "partially_paid", "denied", "voided"],
  partially_paid: ["paid", "denied", "voided"],
  denied: ["submitted", "voided"], // refiled claims go out again
  paid: [],
  voided: [],
};

export async function markStatus(args: {
  orgId: string;
  id: string;
  to: SuperbillStatus;
  paidAmountCents?: number;
}): Promise<{ from: SuperbillStatus; to: SuperbillStatus }> {
  return withOrgContext(args.orgId, async (tx) => {
    // FOR UPDATE: serialize concurrent transitions on the same superbill —
    // check-then-update without the lock could apply two conflicting moves.
    const rows = await tx.$queryRaw<{ status: SuperbillStatus }[]>`
      SELECT status FROM superbill WHERE id = ${args.id}::uuid LIMIT 1 FOR UPDATE
    `;
    const from = rows[0]?.status;
    if (!from) throw new NotFoundError("Superbill not found.");
    if (!STATUS_TRANSITIONS[from].includes(args.to)) {
      throw new Error(`Illegal superbill transition ${from} → ${args.to}.`);
    }
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
    return { from, to: args.to };
  });
}
