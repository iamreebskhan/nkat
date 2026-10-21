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
import { NotFoundError, ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { gateDescriptor } from "@/lib/features/billing/code-pure";
import {
  normalizeUnits,
  unitErrors,
  type CodeUnits,
} from "@/lib/features/billing/code-units";
import { hasAmaLicense } from "@/lib/features/billing/code.service";
import { defaultProductLineForPayerType } from "@/lib/features/billing/payer-rule.repository";
import { predictSuperbill } from "@/lib/features/billing/predict-superbill.service";
import { orgLocalDate } from "@/lib/features/org/org-date";
import { claimRefFor } from "@/lib/features/remittances/claim-ref";
import { tierForCredential, type NpiSource } from "@/lib/features/team/clinician";
import {
  DocumentationIncompleteError,
  documentationGap,
  elementLabel,
} from "@/lib/features/visits/documentation-check";
import { loadDocumentationGaps } from "@/lib/features/visits/documentation-check.service";
import { applyPhiKeyIfConfigured } from "@/lib/hipaa/pgp";
import {
  buildSuperbill,
  priceCodes,
  type DraftSuperbill,
  type PayerRate,
  type ProviderTier,
  type SuperbillPricing,
} from "./superbill-pure";

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

/**
 * A superbill may only be built from a visit that has been signed. Anything
 * earlier is a claim for care nobody has attested to.
 *
 * This has to live in the service, not the route: POST /api/visits/[id]/superbill
 * is only one of two callers — the visit transition route auto-persists a draft
 * on documented → pending_billing — and only one of them was ever going to grow
 * a status check.
 */
const SIGNED_STATUSES = ["documented", "pending_billing", "billed"] as const;

interface VisitForSuperbill {
  id: string;
  status: string;
  patient_id: string;
  is_telehealth: boolean;
  cpt_codes_assigned: string[] | null;
  /** Units per code when more than one (0106); {} = one each. */
  cpt_units?: CodeUnits | null;
  icd10_codes: string[] | null;
  modifiers: string[] | null;
  scheduled_start: Date | null;
  start_time: Date | null;
  primary_payer_id: string | null;
  primary_member_id: string | null;
  /** Intake-captured diagnosis — the fallback when the visit carries none. */
  primary_diagnosis_icd10: string | null;
  /** The rendering clinician's own NPI, from clinician_profile (audit R40). */
  clinician_npi: string | null;
  /** The clinician's licensure — sets the pricing tier (audit R25). */
  credential: string | null;
  /** The organization's NPI from onboarding — the billing provider. */
  org_npi: string | null;
  full_name: string | null;
  /** The patient's coverage state: the policy state, else the address state. */
  coverage_state: string | null;
  /** Recorded on the visit (audit R23); NULL on visits before 0095. */
  place_of_service_code: string | null;
  /** From the POS table: 'facility' is priced at the facility rate. */
  pos_facility: string | null;
  /** The band the visit's type bills as; 'non_billable' is never billed (audit R18). */
  coding_basis: string | null;
  /** org.timezone (0107): the date of service is the visit's day in it. */
  org_timezone: string;
}

type Tx =Parameters<Parameters<typeof withOrgContext>[1]>[0];

const toCents = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * The payer's rates on file for these codes on the date of service (audit
 * R33): payer_rule 'covered' rows carrying value.rate. The same rule as the
 * rule check on the same screen — in force on the DOS, not superseded, the
 * payer's own product line ranked first.
 */
async function readPayerRates(
  tx: Tx,
  a: { payerId: string; state: string; codes: string[]; dos: string },
): Promise<PayerRate[]> {
  if (a.codes.length === 0) return [];
  const pt = await tx.$queryRaw<
    { payer_type: Parameters<typeof defaultProductLineForPayerType>[0] }[]
  >`
    SELECT payer_type FROM payer WHERE id = ${a.payerId}::uuid LIMIT 1
  `;
  const productLine = defaultProductLineForPayerType(pt[0]?.payer_type ?? null);
  const rows = await tx.$queryRaw<
    { code: string; id: string; value: Record<string, unknown>; effective_date: string }[]
  >`
    SELECT DISTINCT ON (pr.code) pr.code, pr.id, pr.value,
           to_char(pr.effective_date, 'YYYY-MM-DD') AS effective_date
      FROM payer_rule pr
     WHERE pr.payer_id = ${a.payerId}::uuid
       AND pr.state = ${a.state}
       AND pr.code = ANY(${a.codes}::text[])
       AND pr.attribute = 'covered'
       AND pr.value->>'rate' IS NOT NULL
       AND pr.superseded_by IS NULL
       AND pr.effective_date <= ${a.dos}::date
       AND (pr.expiration_date IS NULL OR pr.expiration_date > ${a.dos}::date)
     ORDER BY pr.code, (pr.product_line = ${productLine}) DESC, pr.effective_date DESC
  `;
  return rows.flatMap((r) => {
    const rateCents = toCents(r.value.rate);
    if (rateCents === null) return [];
    return [
      {
        code: r.code,
        rateCents,
        npPaRateCents: toCents(r.value.npPaRate),
        facilityRateCents: toCents(r.value.facilityRate),
        payerRuleId: r.id,
        rateBasis: typeof r.value.rateBasis === "string" ? r.value.rateBasis : null,
        effectiveDate: r.effective_date,
      },
    ];
  });
}

/**
 * Reprice a saved bill from its current codes, units, payer, coverage state
 * and place of service (audit R33). Editing 99349 to 99350 used to keep
 * 99349's price. The tier is the one the bill was priced at; bills from before
 * 0094 carry none, so the clinician's credential decides, then the lower NP/PA.
 */
async function repriceSuperbill(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ before: number; after: number; pricing: SuperbillPricing } | null> {
  const rows = await tx.$queryRaw<
    {
      payer_id: string | null;
      dos: string;
      coverage_state: string | null;
      tier: string | null;
      credential: string | null;
      cpt: string[] | null;
      units: CodeUnits | null;
      billed: bigint | number;
      facility: string | null;
    }[]
  >`
    SELECT s.payer_id, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos,
           COALESCE(p.insurance_state, p.state) AS coverage_state,
           s.pricing->>'tier' AS tier, cp.credential,
           s.cpt_codes AS cpt, s.cpt_units AS units, s.billed_amount_cents AS billed,
           pos.facility_indicator AS facility
      FROM superbill s
      -- The bill's own org's patient and visit: both FKs are id-only, and the
      -- org is named as well as enforced by RLS throughout this file, so on a
      -- connection that bypasses RLS a bill id never reaches another org's row.
      JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
      LEFT JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
      LEFT JOIN clinician_profile cp ON cp.org_id = s.org_id AND cp.user_id = v.clinician_user_id
      LEFT JOIN pos ON pos.pos = s.place_of_service_code
     WHERE s.id = ${id}::uuid
       AND s.org_id = ${orgId}::uuid
     LIMIT 1
  `;
  const c = rows[0];
  if (!c) return null;
  const tier: ProviderTier =
    c.tier === "MD" || c.tier === "NP_PA" ? c.tier : (tierForCredential(c.credential) ?? "NP_PA");
  const codes = c.cpt ?? [];
  const rates =
    c.payer_id && c.coverage_state
      ? await readPayerRates(tx, { payerId: c.payer_id, state: c.coverage_state, codes, dos: c.dos })
      : [];
  const priced = priceCodes(codes, tier, rates, {
    facility: c.facility === "facility",
    units: c.units ?? {},
  });
  const pricing: SuperbillPricing = { tier, lines: priced.lines };
  await tx.$executeRaw`
    UPDATE superbill
       SET billed_amount_cents = ${priced.totalCents},
           pricing = ${JSON.stringify(pricing)}::jsonb,
           updated_at = now()
     WHERE id = ${id}::uuid
       AND org_id = ${orgId}::uuid
  `;
  return { before: Number(c.billed), after: priced.totalCents, pricing };
}

/**
 * Read the joined data needed to build a draft superbill.
 *
 * Who the claim names comes from the visit's clinician, as recorded on the
 * Team page: their own NPI as rendering provider (audit R40) and their
 * credential for the pricing tier (audit R25). The organization's onboarding
 * NPI travels separately as the billing provider.
 */
export async function buildDraftFromVisit(args: {
  orgId: string;
  visitId: string;
}): Promise<DraftSuperbill> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<VisitForSuperbill[]>`
      SELECT v.id, v.status, v.patient_id, v.is_telehealth,
             v.cpt_codes_assigned, v.cpt_units, v.icd10_codes, v.modifiers,
             v.scheduled_start, v.start_time,
             p.primary_payer_id, p.primary_member_id,
             p.primary_diagnosis_icd10,
             cp.npi AS clinician_npi,
             cp.credential,
             ob.npi AS org_npi,
             u.full_name,
             COALESCE(p.insurance_state, p.state) AS coverage_state,
             v.place_of_service_code,
             pos.facility_indicator AS pos_facility,
             -- The band the visit's type bills as (audit R18).
             (SELECT ot.coding_basis FROM org_visit_type ot
               WHERE ot.org_id = v.org_id AND ot.slug = v.visit_type
               LIMIT 1) AS coding_basis,
             o.timezone AS org_timezone
      FROM visit v
      -- The visit's own org's patient (the FK is id-only), and the visit
      -- found by org as well as id: the bill is built from what this reads.
      JOIN patient p ON p.id = v.patient_id AND p.org_id = v.org_id
      JOIN org o ON o.id = v.org_id
      LEFT JOIN app_user u ON u.id = v.clinician_user_id
      LEFT JOIN clinician_profile cp
             ON cp.org_id = v.org_id AND cp.user_id = v.clinician_user_id
      LEFT JOIN onboarding_status ob ON ob.org_id = v.org_id
      LEFT JOIN pos ON pos.pos = v.place_of_service_code
      WHERE v.id = ${args.visitId}::uuid
        AND v.org_id = ${args.orgId}::uuid
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) throw new NotFoundError("Visit not found.");
    // A "Not billed" visit type never gets a bill, whichever door is used
    // (audit R18): the visit's bill page, Create Bill on the billing side and
    // the sign-off auto-draft all come through here. Checked before the
    // signed test, so an unsigned one is not told to sign in order to bill.
    if (r.coding_basis === "non_billable") {
      throw new ValidationError("This visit type is not billed, so no bill can be created for it.");
    }
    if (!SIGNED_STATUSES.includes(r.status as (typeof SIGNED_STATUSES)[number])) {
      throw new ValidationError(
        `This visit is ${r.status} and has not been signed. Sign the visit before creating a bill — the note is what the billed codes are defended with.`,
      );
    }

    // The date of service is the day the visit started where the practice is
    // (0107). Its UTC day, as this used to take, is already tomorrow for any
    // US visit in the evening: the wrong fee schedule, the wrong date on the
    // claim, and an 835 whose date did not match.
    const dos = orgLocalDate(r.start_time ?? r.scheduled_start ?? new Date(), r.org_timezone);

    // The rendering provider is the clinician's own NPI. It falls back to the
    // organization's onboarding NPI only so a solo practice that entered its
    // own number at onboarding keeps working, and the draft says so rather
    // than sending the org number out silently as it used to (audit R40).
    const clinicianNpi = r.clinician_npi?.trim() ?? "";
    const orgNpi = r.org_npi?.trim() ?? "";
    const npiSource: NpiSource = clinicianNpi ? "clinician" : orgNpi ? "organization" : "none";

    // The payer's rates on file for the date of service (audit R33): what the
    // claim is priced at, instead of a hardcoded 2025 Medicare table.
    const codes = r.cpt_codes_assigned ?? [];
    const payerRates =
      r.primary_payer_id && r.coverage_state && codes.length > 0
        ? await readPayerRates(tx, {
            payerId: r.primary_payer_id,
            state: r.coverage_state,
            codes,
            dos,
          })
        : [];

    return buildSuperbill({
      visit: {
        id: r.id,
        patientId: r.patient_id,
        isTelehealth: r.is_telehealth,
        cptCodesAssigned: r.cpt_codes_assigned ?? [],
        // The add-on units the clinician's note supports (0106); {} on
        // visits signed before it, which bills one of each as it always did.
        cptUnits: r.cpt_units ?? {},
        // The visit's own diagnoses, captured on the document screen and
        // required at sign-off (audit R13). The patient's intake diagnosis is
        // only a fallback for visits signed before that requirement existed —
        // without it those older claims would carry no diagnosis at all.
        icd10Codes:
          r.icd10_codes && r.icd10_codes.length > 0
            ? r.icd10_codes
            : r.primary_diagnosis_icd10
              ? [r.primary_diagnosis_icd10]
              : [],
        modifiers: r.modifiers ?? [],
        dos,
      },
      patient: {
        id: r.patient_id,
        primaryPayerId: r.primary_payer_id,
        primaryMemberId: r.primary_member_id,
      },
      provider: {
        npi: clinicianNpi || orgNpi,
        fullName: r.full_name ?? "",
        // Tier follows the clinician's licence (audit R25). With no credential
        // recorded, or one that does not bill E/M, price at the lower NP/PA
        // rate — and the draft warns why.
        tier: tierForCredential(r.credential) ?? "NP_PA",
        billingNpi: orgNpi,
        npiSource,
        credential: r.credential,
      },
      // Where the visit took place (audit R23), and whether that is a facility.
      placeOfServiceCode: r.place_of_service_code,
      posFacility: r.pos_facility === "facility",
      payerRates,
    });
  });
}

/** The visit's bill, if it has one (visit_id is UNIQUE). */
async function billIdForVisit(tx: Tx, orgId: string, visitId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM superbill WHERE visit_id = ${visitId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Persist the draft as a `superbill` row: once per visit (visit_id is UNIQUE).
 *
 * A second call for a visit that already has a bill returns that bill's id
 * with created: false, and writes nothing. It used to write the visit's codes,
 * units, diagnoses, modifiers and price over the bill whatever its status, with
 * no line on the bill's history, its status unchanged and a second
 * superbill_create in the audit log. Nothing calls this on purpose for a
 * billed visit: the bill page and Create Bill call it when the bill did not
 * exist when they loaded, and sign-off when it moves the visit to billing. So
 * it ran when a bill was saved in another tab or by someone else while a page
 * was open, or when a visit billed from the billing side was then submitted.
 * Signing freezes the visit's codes (LOCKED_AFTER_SIGNING), so there was never
 * anything newer to bring in; all it could do was undo a biller's edits, under
 * a reviewed or submitted status that then no longer described the claim.
 */
export async function persistDraft(args: {
  orgId: string;
  draft: DraftSuperbill;
  /** Recorded on the activity trail's "created" entry. */
  actorUserId?: string;
}): Promise<{ id: string; created: boolean }> {
  const { orgId, draft } = args;

  // Already billed: nothing to write, and nothing to score.
  const existing = await withOrgContext(orgId, (tx) => billIdForVisit(tx, orgId, draft.visitId));
  if (existing) return { id: existing, created: false };

  // Phase B — capture the predictor result at save-time. Best-effort:
  // if predict fails (e.g. payer rules missing) we persist with NULL
  // and the nightly feedback cron just skips this row.
  // The scorer keys payer rules on (payer, STATE, code). Passing null state
  // matched nothing, so every superbill created by signing a visit stored
  // "No rule on file for 99349 with this payer" and "confidence 0.00" for
  // codes the very same screen had just shown as Covered with a citation.
  //
  // The old note here said the picker path would supply the state on update.
  // Nothing updates a superbill that came from signing a visit, so that
  // correction never arrived and the wrong risk was what the biller saw.
  // Worse, it read SAFER than the truth: without rules the scorer cannot see
  // missing_modifier or prior_auth_missing, so a line that is actually a
  // block came out medium — this feature exists to catch exactly those two.
  //
  // The state is not on the draft, but the patient is. Read it, preferring
  // the coverage state over the residence state, since that is what the
  // rules are keyed on. Best-effort: on any failure fall back to the old
  // null and let the scorer flag coverage_unknown as before.
  let coverageState: string | null = null;
  try {
    coverageState = await withOrgContext(orgId, async (tx) => {
      const rows = await tx.$queryRaw<{ state: string | null }[]>`
        SELECT COALESCE(insurance_state, state) AS state
          FROM patient
         WHERE id = ${draft.patientId}::uuid
           AND org_id = ${orgId}::uuid
         LIMIT 1
      `;
      return rows[0]?.state ?? null;
    });
  } catch {
    /* leave null — previous behaviour */
  }

  let predictedRisk: unknown = null;
  try {
    predictedRisk = await predictSuperbill({
      orgId,
      payerId: draft.payerId,
      state: coverageState,
      patientId: draft.patientId,
      dos: draft.dateOfService,
      cptCodes: draft.cptCodes,
      modifiers: draft.modifiers,
      icd10Codes: draft.icd10Codes,
      // The bill row does not exist yet, so its note is read through the
      // visit: the risk stored at sign-off then carries a payer documentation
      // gap too, not only the later previews (audit R19).
      visitId: draft.visitId,
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
        cpt_codes, cpt_units, icd10_codes, modifiers,
        provider_npi, provider_name, billing_npi, place_of_service_code,
        billed_amount_cents, status, predicted_risk, pricing
      ) VALUES (
        ${orgId}::uuid, ${draft.visitId}::uuid, ${draft.patientId}::uuid,
        ${draft.payerId ?? null}::uuid,
        ${draft.memberIdSnapshot},
        CASE WHEN ${phi} THEN encrypt_phi(${draft.memberIdSnapshot}) ELSE NULL END,
        ${draft.dateOfService}::date,
        ${draft.cptCodes}::text[], ${JSON.stringify(draft.cptUnits ?? {})}::jsonb,
        ${draft.icd10Codes}::text[], ${draft.modifiers}::text[],
        ${draft.providerNpi}, ${draft.providerName}, ${draft.billingNpi || null},
        ${draft.placeOfServiceCode},
        ${draft.billedAmountCents}, 'draft',
        ${predictedRisk ? JSON.stringify(predictedRisk) : null}::jsonb,
        ${JSON.stringify(draft.pricing)}::jsonb
      )
      ON CONFLICT (visit_id) DO NOTHING
      RETURNING id
    `;
    if (!rows[0]) {
      // Saved by someone else between the read above and this insert: theirs
      // stands, as it would had it come first.
      const won = await billIdForVisit(tx, orgId, draft.visitId);
      if (!won) throw new Error("The visit's bill could not be read back after a save conflict.");
      return { id: won, created: false };
    }
    const id = rows[0].id;
    // Written only with a new bill, so the trail starts with it; the guard is
    // kept so a bill can never be given a second "created" line.
    await tx.$executeRaw`
      INSERT INTO superbill_activity (org_id, superbill_id, actor_user_id, kind, to_status, summary, detail)
      SELECT ${orgId}::uuid, ${id}::uuid, ${args.actorUserId ?? null}::uuid, 'created', 'draft',
             'Superbill created from the visit',
             ${JSON.stringify({
               billedAmountCents: draft.billedAmountCents,
               cptCodes: draft.cptCodes,
               cptUnits: draft.cptUnits ?? {},
             })}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM superbill_activity WHERE superbill_id = ${id}::uuid
      )
    `;
    // superbill_activity is the biller's own timeline for one claim. This is
    // the org-wide trail an investigator reads, and a superbill is PHI on its
    // way to a payer, so it belongs in both. Codes and amounts only — those
    // are the claim, not the chart.
    await writeAudit(tx, {
      orgId,
      userId: args.actorUserId ?? null,
      action: "superbill_create",
      targetType: "superbill",
      targetId: id,
      payload: {
        visitId: draft.visitId,
        patientId: draft.patientId,
        payerId: draft.payerId ?? null,
        cptCodes: draft.cptCodes,
        billedAmountCents: draft.billedAmountCents,
        riskScored: predictedRisk !== null,
      },
    });
    return { id, created: true };
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
  /** Units per code when more than one (0106); {} = one each, as on every older bill. */
  cptUnits: CodeUnits;
  icd10Codes: string[];
  modifiers: string[];
  providerNpi: string;
  providerName: string;
  /** Billing provider NPI (CMS-1500 box 33a): the organization's. */
  billingNpi: string;
  placeOfServiceCode: string;
  billedAmountCents: number;
  paidAmountCents: number | null;
  /**
   * Where paidAmountCents came from (audit R10): 'recorded' when typed in
   * Pallio, 'remittance' when posted from a payer's 835. null while unpaid.
   */
  paidSource: "recorded" | "remittance" | null;
  /**
   * What to enter as the patient account no. (CMS-1500 box 26) when the claim
   * goes out, so the payer's 835 matches back to this bill (audit R10).
   */
  claimRef: string;
  status: SuperbillStatus;
  submittedAt: string | null;
  paidAt: string | null;
  generatedPdfPath: string | null;
  /** Phase B — predictor output captured at save-time. */
  predictedRisk: unknown | null;
  /** How billedAmountCents was priced (audit R33); {} on older bills. */
  pricing: Partial<SuperbillPricing>;
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
  /** Absent from rows read before 0106. */
  cpt_units?: CodeUnits | null;
  icd10_codes: string[];
  modifiers: string[];
  provider_npi: string;
  provider_name: string;
  /** NULL on bills saved before 0092. */
  billing_npi: string | null;
  place_of_service_code: string;
  billed_amount_cents: number;
  paid_amount_cents: number | null;
  /** NULL while unpaid, and absent on reads before 0102. */
  paid_source?: "recorded" | "remittance" | null;
  status: SuperbillStatus;
  submitted_at: Date | null;
  paid_at: Date | null;
  generated_pdf_path: string | null;
  predicted_risk: unknown | null;
  pricing?: Partial<SuperbillPricing> | null;
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
    cptUnits: r.cpt_units ?? {},
    icd10Codes: r.icd10_codes,
    modifiers: r.modifiers ?? [],
    providerNpi: r.provider_npi,
    providerName: r.provider_name,
    billingNpi: r.billing_npi ?? "",
    placeOfServiceCode: r.place_of_service_code,
    billedAmountCents: Number(r.billed_amount_cents),
    paidAmountCents: r.paid_amount_cents ? Number(r.paid_amount_cents) : null,
    paidSource: r.paid_source ?? null,
    claimRef: claimRefFor(r.id),
    status: r.status,
    submittedAt: r.submitted_at?.toISOString() ?? null,
    paidAt: r.paid_at?.toISOString() ?? null,
    generatedPdfPath: r.generated_pdf_path,
    predictedRisk: r.predicted_risk,
    pricing: r.pricing ?? {},
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
      SELECT * FROM superbill
       WHERE visit_id = ${args.visitId}::uuid AND org_id = ${args.orgId}::uuid
       LIMIT 1
    `;
    return rows[0] ? rowToView(rows[0]) : null;
  });
}

/** A list row: the superbill, whose it is, and what each of its codes means. */
export type ListedSuperbill = SuperbillView & {
  /**
   * Descriptor for each CPT/HCPCS code on the claim, from the rulebook-fed
   * `code` table. null when a code is not in that table, so a missing
   * descriptor reads as missing rather than as a code that was dropped.
   */
  codeDescriptors: Record<string, string | null>;
  /**
   * The patient's name, joined in the same query. A queue row that showed
   * only a date and an amount could not say whose claim it was (audit R16).
   */
  patientName: string;
};

export async function listSuperbills(args: {
  orgId: string;
  status?: SuperbillStatus;
  /** One patient's bills, filtered in SQL rather than after a capped fetch. */
  patientId?: string;
  limit?: number;
  /** Rows to skip. With countSuperbills, what lets a screen reach row 51. */
  offset?: number;
}): Promise<ListedSuperbill[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const rawOffset = args.offset ?? 0;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<(SuperbillRow & { patient_name: string | null })[]>`
      SELECT s.*, TRIM(p.first_name || ' ' || p.last_name) AS patient_name
        FROM superbill s
        JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
       WHERE s.org_id = ${args.orgId}::uuid
         AND (${args.status ?? null}::text IS NULL OR s.status = ${args.status ?? null})
         AND (${args.patientId ?? null}::uuid IS NULL OR s.patient_id = ${args.patientId ?? null}::uuid)
       ORDER BY s.date_of_service DESC, s.created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
    const views = rows.map((r) => ({ ...rowToView(r), patientName: r.patient_name ?? "" }));

    // The codes were always on every row — rowToView carries cptCodes — but
    // the list screens never rendered them, so a biller saw a date and a
    // dollar amount and had to open each claim to learn what was billed.
    // Descriptors come from the same `code` table the rulebooks populate,
    // read with the same in-force-today rule as the CPT time bands, in one
    // query for the whole page rather than one per claim.
    const codes = [...new Set(views.flatMap((v) => v.cptCodes ?? []))];
    const desc = new Map<string, string | null>();
    if (codes.length > 0) {
      const found = await tx.$queryRaw<
        { code: string; code_system: string | null; short_descriptor: string | null }[]
      >`
        SELECT DISTINCT ON (c.code) c.code, c.code_system, c.short_descriptor
          FROM code c
         WHERE c.code = ANY(${codes}::text[])
           AND c.effective_date <= CURRENT_DATE
           AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)
         ORDER BY c.code, c.effective_date DESC
      `;
      // CPT descriptors are AMA-licensed (audit R21). These lists showed the
      // full text on a deployment without the licence while the Rulebook and
      // the sidebar badge said it was redacted.
      const licensed = hasAmaLicense();
      for (const f of found) desc.set(f.code, gateDescriptor(f.code_system, f.short_descriptor, licensed));
    }

    return views.map((v) => ({
      ...v,
      codeDescriptors: Object.fromEntries(
        (v.cptCodes ?? []).map((c) => [c, desc.get(c) ?? null]),
      ),
    }));
  });
}

/**
 * How many superbills match the list's filters: the real size of the queue,
 * not the size of one page (audit R34). Same predicates as listSuperbills.
 */
export async function countSuperbills(args: {
  orgId: string;
  status?: SuperbillStatus;
  patientId?: string;
}): Promise<number> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM superbill s
       WHERE s.org_id = ${args.orgId}::uuid
         AND (${args.status ?? null}::text IS NULL OR s.status = ${args.status ?? null})
         AND (${args.patientId ?? null}::uuid IS NULL OR s.patient_id = ${args.patientId ?? null}::uuid)
    `;
    return Number(rows[0]?.n ?? 0);
  });
}

export interface UpdateSuperbillResult {
  updated: boolean;
  /** Set when the edit repriced the bill: its codes, units or place of service changed. */
  billedAmountCents?: number;
  pricing?: SuperbillPricing;
  /** Set when the edit sent a reviewed bill back to draft (audit R26). */
  status?: SuperbillStatus;
  /**
   * The units map as written, normalized, whenever the codes or units were
   * written (0106). The page shows this rather than the edit it sent: removing
   * G0318 drops its units, so re-adding it is one unit, not a stale × 2.
   */
  cptUnits?: CodeUnits;
}

/**
 * Edit a draft superbill (Phase A — payer-scoped picker).
 *
 * Lets the nurse change the CPT / ICD-10 / modifier sets, and the units on a
 * per-increment add-on (0106), on a saved draft before they advance the
 * status. Each call also takes an
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
    /** Units per code when more than one (0106); only G0318, 99417 and 99498 take them. */
    cptUnits?: CodeUnits;
    icd10Codes?: string[];
    modifiers?: string[];
    /** Where the visit took place (audit R23), corrected on the bill. */
    placeOfServiceCode?: string;
  };
  overrides?: Array<{ code: string; reason: string }>;
}): Promise<UpdateSuperbillResult> {
  return withOrgContext(args.orgId, async (tx) => {
    // The org is named in every statement of this edit as well as enforced by
    // RLS: each one matched the bill on its id alone.
    const exists = await tx.$queryRaw<{ id: string; status: SuperbillStatus }[]>`
      SELECT id, status FROM superbill WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid LIMIT 1
    `;
    if (!exists[0]) throw new NotFoundError("Superbill not found.");
    // A DENIED claim must be editable — that is the whole correction loop the
    // client described (walkthrough 05:48): the payer changed a rule, rejected
    // the claim, and the nurse fixes the codes and resubmits. 'submitted' stays
    // locked (it's in flight with the payer) and paid/voided are terminal.
    const EDITABLE: SuperbillStatus[] = ["draft", "ready_to_submit", "denied"];
    if (!EDITABLE.includes(exists[0].status)) {
      throw new ValidationError(
        `Superbill is ${exists[0].status}; only draft, ready-to-submit or denied claims can be edited.`,
      );
    }
    const statusBefore = exists[0].status;

    let touched = false;
    // The codes and their units are written together (0106), so a units map
    // can never outlive the codes it counts: a code removed here takes its
    // units with it, and a units-only edit is priced against the codes the
    // bill already carries. Read separately from the status check above,
    // which stays the one statement that guards editability.
    let unitsWritten: CodeUnits | undefined;
    if (args.patch.cptCodes || args.patch.cptUnits) {
      const current = await tx.$queryRaw<{ cpt_codes: string[] | null; cpt_units: CodeUnits | null }[]>`
        SELECT cpt_codes, cpt_units FROM superbill
         WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid LIMIT 1
      `;
      const codes = args.patch.cptCodes ?? current[0]?.cpt_codes ?? [];
      // Units above one only on the per-increment add-ons: a home E/M is
      // reported once per date of service. Refused before anything is written.
      const problems = args.patch.cptUnits ? unitErrors(codes, args.patch.cptUnits) : [];
      if (problems.length > 0) throw new ValidationError(problems.join(" "));
      unitsWritten = normalizeUnits(codes, args.patch.cptUnits ?? current[0]?.cpt_units ?? {});
      await tx.$executeRaw`
        UPDATE superbill
           SET cpt_codes = ${codes}::text[],
               cpt_units = ${JSON.stringify(unitsWritten)}::jsonb,
               updated_at = now()
         WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      touched = true;
    }
    if (args.patch.icd10Codes) {
      await tx.$executeRaw`
        UPDATE superbill SET icd10_codes = ${args.patch.icd10Codes}::text[], updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      touched = true;
    }
    if (args.patch.modifiers) {
      await tx.$executeRaw`
        UPDATE superbill SET modifiers = ${args.patch.modifiers}::text[], updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      touched = true;
    }
    if (args.patch.placeOfServiceCode) {
      const pos = args.patch.placeOfServiceCode;
      const known = await tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM pos
         WHERE pos = ${pos} AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
         LIMIT 1
      `;
      if (!known[0]) throw new ValidationError(`Unknown place-of-service code "${pos}".`);
      await tx.$executeRaw`
        UPDATE superbill SET place_of_service_code = ${pos}, updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
      `;
      touched = true;
    }

    // Reprice when what the price depends on changed (audit R33): the codes,
    // their units (0106), or the place of service, since a facility is priced
    // at its own rate.
    const repriced =
      args.patch.cptCodes || args.patch.cptUnits || args.patch.placeOfServiceCode
        ? await repriceSuperbill(tx, args.orgId, args.id)
        : null;

    if (args.overrides && args.overrides.length > 0) {
      // The code and the reason's length only. The reason is free text a
      // biller types and the audit log holds no free text (audit-write.ts);
      // it stays on the claim history below, behind billing permissions.
      for (const o of args.overrides) {
        await tx.$executeRaw`
          INSERT INTO audit_log (
            org_id, user_id, action, target_type, target_id, payload
          ) VALUES (
            ${args.orgId}::uuid, ${args.userId}::uuid,
            'superbill_code_override', 'superbill', ${args.id}::uuid,
            ${JSON.stringify({ code: o.code, reasonLength: o.reason.length })}::jsonb
          )
        `;
      }
    }

    // A reviewed bill that changes is no longer the bill that was reviewed
    // (audit R26). It goes back to draft for re-review, and the trail says so.
    const sentBack = touched && statusBefore === "ready_to_submit";
    if (sentBack) {
      const back = await tx.$queryRaw<{ visit_id: string | null }[]>`
        UPDATE superbill SET status = 'draft', updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
        RETURNING visit_id
      `;
      // A status change, so it belongs in the audit trail too (audit R24).
      await writeAudit(tx, {
        orgId: args.orgId,
        userId: args.userId,
        action: "superbill_status_change",
        targetType: "superbill",
        targetId: args.id,
        payload: { from: "ready_to_submit", to: "draft", visitId: back[0]?.visit_id ?? null },
      });
    }

    if (touched) {
      // Name the fields that changed — after a denial this is the record of
      // what was actually corrected before resubmission.
      const changed = [
        args.patch.cptCodes ? "CPT codes" : null,
        args.patch.cptUnits ? "units" : null,
        args.patch.icd10Codes ? "ICD-10 codes" : null,
        args.patch.modifiers ? "modifiers" : null,
        args.patch.placeOfServiceCode ? "place of service" : null,
      ].filter(Boolean);
      await tx.$executeRaw`
        INSERT INTO superbill_activity (
          org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail
        ) VALUES (
          ${args.orgId}::uuid, ${args.id}::uuid, ${args.userId}::uuid, 'edited',
          ${statusBefore}, ${sentBack ? "draft" : statusBefore},
          ${
            statusBefore === "denied"
              ? `Corrected after denial — updated ${changed.join(", ")}`
              : sentBack
                ? `Edited after review — updated ${changed.join(", ")} — back to draft for re-review`
                : `Edited ${changed.join(", ")}`
          },
          ${JSON.stringify({
            cptCodes: args.patch.cptCodes,
            // The units as written, whenever the codes or units were: a code
            // edit can drop units too, and the trail says what was billed.
            cptUnits: unitsWritten,
            icd10Codes: args.patch.icd10Codes,
            modifiers: args.patch.modifiers,
            placeOfServiceCode: args.patch.placeOfServiceCode,
            overrides: args.overrides ?? [],
            // The price before and after, when the edit repriced the bill.
            billedAmountCents: repriced ? { before: repriced.before, after: repriced.after } : undefined,
          })}::jsonb
        )
      `;
    }

    return {
      updated: touched,
      ...(repriced ? { billedAmountCents: repriced.after, pricing: repriced.pricing } : {}),
      ...(sentBack ? { status: "draft" as const } : {}),
      ...(unitsWritten ? { cptUnits: unitsWritten } : {}),
    };
  }).then(async (result) => {
    // Phase B — recapture predicted_risk after the nurse's edits so the
    // stored prediction reflects the codes actually on the bill (the
    // feedback loop compares THIS against the real denial). Best-effort:
    // a predictor failure must not fail the edit. Runs after the edit tx
    // commits so predictSuperbill's own context sees the new codes.
    if (!result.updated) return result;
    await recaptureRisk(args.orgId, args.id);
    return result;
  });
}

/**
 * Store the predictor's view of the bill as it now stands. After an edit or a
 * correction, so the prediction the feedback loop later holds against a real
 * denial is of the bill that went out. Best-effort: a predictor failure is
 * logged and never fails the change that called it.
 */
async function recaptureRisk(orgId: string, id: string): Promise<void> {
  try {
    const ctx = await withOrgContext(orgId, async (tx) =>
      tx.$queryRaw<
        { payer_id: string | null; patient_id: string; dos: Date; state: string | null; cpt: string[]; mods: string[] }[]
      >`
        SELECT s.payer_id, s.patient_id, s.date_of_service AS dos,
               -- The coverage state the payer's rules are keyed on, as
               -- persistDraft reads it; this read the address state alone.
               COALESCE(p.insurance_state, p.state) AS state,
               s.cpt_codes AS cpt, s.modifiers AS mods
          FROM superbill s JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
         WHERE s.id = ${id}::uuid AND s.org_id = ${orgId}::uuid LIMIT 1
      `,
    );
    const c = ctx[0];
    if (c) {
      const risk = await predictSuperbill({
        orgId,
        payerId: c.payer_id,
        state: c.state,
        patientId: c.patient_id,
        // This super-bill already exists, so its own lines are not
        // prior history — without this a "max one per period" rule
        // fires on the very claim that is the first occurrence.
        excludeSuperbillId: id,
        dos: c.dos.toISOString().slice(0, 10),
        cptCodes: c.cpt ?? [],
        modifiers: c.mods ?? [],
      });
      await withOrgContext(orgId, async (tx) => {
        await tx.$executeRaw`
          UPDATE superbill SET predicted_risk = ${JSON.stringify(risk)}::jsonb, updated_at = now()
           WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
        `;
      });
    }
  } catch (e) {
    console.warn("predicted_risk recapture failed (non-fatal):", e);
  }
}

/**
 * Re-date a bill still being worked to the day its visit started where the
 * practice is (0107).
 *
 * A bill drafted before 0107 was dated by the visit start's UTC day, which for
 * an evening visit in the US is already the next day, and a draft keeps the
 * date it was created with: its visit is signed, so nothing re-dates it. The
 * bill page offers this when the two days differ.
 *
 * Repriced at the payer's rates for the corrected day, since a rate can change
 * between the two (a fee schedule's 1 January, say). Only before the claim goes
 * out: a submitted claim's date is what the payer holds and echoes in the 835,
 * so it is never changed here. A reviewed bill that changes goes back to draft
 * for re-review, as any edit sends it (audit R26).
 */
export async function correctDateOfService(args: {
  orgId: string;
  id: string;
  userId: string;
}): Promise<{ from: string; to: string; billedAmountCents: number; status: SuperbillStatus }> {
  const result = await withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      { status: SuperbillStatus; dos: string; day: string | null; billed: bigint | number }[]
    >`
      SELECT s.status, to_char(s.date_of_service, 'YYYY-MM-DD') AS dos,
             -- The day buildDraftFromVisit dates a new bill by: the visit's
             -- start, else its booked start, where the practice is.
             to_char((COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date,
                     'YYYY-MM-DD') AS day,
             s.billed_amount_cents AS billed
        FROM superbill s
        JOIN org o ON o.id = s.org_id
        LEFT JOIN visit v ON v.id = s.visit_id AND v.org_id = s.org_id
       WHERE s.id = ${args.id}::uuid AND s.org_id = ${args.orgId}::uuid
       LIMIT 1
       FOR UPDATE OF s
    `;
    const r = rows[0];
    if (!r) throw new NotFoundError("Superbill not found.");
    if (r.status !== "draft" && r.status !== "ready_to_submit") {
      throw new ValidationError(
        `This claim is ${r.status.replace(/_/g, " ")}. Its date of service is the one the payer holds, so it is not changed here.`,
      );
    }
    if (!r.day) throw new ValidationError("This bill's visit has no start time to date it by.");
    if (r.day === r.dos) {
      throw new ValidationError(`The date of service is already ${r.dos}, the day the visit started.`);
    }

    await tx.$executeRaw`
      UPDATE superbill SET date_of_service = ${r.day}::date, updated_at = now()
       WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    const repriced = await repriceSuperbill(tx, args.orgId, args.id);

    const sentBack = r.status === "ready_to_submit";
    if (sentBack) {
      const back = await tx.$queryRaw<{ visit_id: string | null }[]>`
        UPDATE superbill SET status = 'draft', updated_at = now()
        WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
        RETURNING visit_id
      `;
      await writeAudit(tx, {
        orgId: args.orgId,
        userId: args.userId,
        action: "superbill_status_change",
        targetType: "superbill",
        targetId: args.id,
        payload: { from: "ready_to_submit", to: "draft", visitId: back[0]?.visit_id ?? null },
      });
    }

    // On the claim's own history, which carries the claim: the two dates and
    // the price before and after.
    const corrected = `Date of service corrected to ${r.day}, the day the visit started at the practice (was ${r.dos})`;
    await tx.$executeRaw`
      INSERT INTO superbill_activity (
        org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail
      ) VALUES (
        ${args.orgId}::uuid, ${args.id}::uuid, ${args.userId}::uuid, 'edited',
        ${r.status}, ${sentBack ? "draft" : r.status},
        ${sentBack ? `${corrected} — back to draft for re-review` : corrected},
        ${JSON.stringify({
          dateOfService: { before: r.dos, after: r.day },
          billedAmountCents: repriced ? { before: repriced.before, after: repriced.after } : undefined,
        })}::jsonb
      )
    `;

    return {
      from: r.dos,
      to: r.day,
      billedAmountCents: repriced ? repriced.after : Number(r.billed),
      status: sentBack ? ("draft" as const) : r.status,
    };
  });
  await recaptureRisk(args.orgId, args.id);
  return result;
}

/**
 * Legal status moves — mirrors the lifecycle documented in the header.
 * Exported so a spec can hold the queue's one-click actions (superbill-queue.ts,
 * client-safe, so it cannot import this) to the same map (audit R35).
 */
export const STATUS_TRANSITIONS: Record<SuperbillStatus, SuperbillStatus[]> = {
  // Review is a checkpoint (audit R26): a draft is marked ready to submit on
  // its bill page before it can go out. Refiles stay one step (denied →
  // submitted), because deciding to refile is its own review.
  draft: ["ready_to_submit", "voided"],
  ready_to_submit: ["submitted", "draft", "voided"],
  submitted: ["paid", "partially_paid", "denied", "voided"],
  partially_paid: ["paid", "denied", "voided"],
  denied: ["submitted", "voided"], // refiled claims go out again
  paid: [],
  voided: [],
};

/**
 * Where a status move came from when no person typed it (audit R10): a payer's
 * 835, uploaded on Remittances. It is carried onto the trail, the audit row and
 * superbill.paid_source, and the payer documentation gate (R19) records a gap
 * rather than stopping the move: that gate stops a claim going out, and the
 * payer has already processed this one.
 */
export interface StatusSource {
  kind: "remittance";
  remittanceFileId: string;
  /** TRN02, the payer's check or EFT trace, cited on the claim history. */
  traceNumber: string | null;
}

/**
 * Human-readable line for the activity trail.
 *
 * In the recorded voice (audit R35). Pallio transmits nothing, so a move to
 * submitted, paid or denied is the org recording what it did or heard
 * elsewhere; "Submitted to the payer" and "Denied by the payer" read, in an
 * appeal or to a client, as the payer's own events. Entries already written
 * keep their wording: the trail is append-only.
 *
 * A move posted from a payer's 835 (audit R10) IS the payer's own event, so
 * it says so, and cites the remittance it came from.
 */
function statusSummary(
  from: SuperbillStatus,
  to: SuperbillStatus,
  paidAmountCents?: number,
  source?: StatusSource,
): string {
  const amount =
    paidAmountCents !== undefined ? ` — $${(paidAmountCents / 100).toFixed(2)}` : "";
  if (source) {
    const trn = source.traceNumber ? ` ${source.traceNumber}` : "";
    if (to === "submitted") return `Submission confirmed by payer remittance${trn}`;
    if (to === "paid") return `Paid${amount}, per payer remittance${trn}`;
    if (to === "partially_paid") return `Partially paid${amount}, per payer remittance${trn}`;
    if (to === "denied") return `Denied by the payer, per remittance${trn}`;
  }
  if (to === "submitted") {
    return from === "denied"
      ? "Recorded as resubmitted to the payer after correction"
      : "Recorded as submitted to the payer";
  }
  if (to === "ready_to_submit") return "Reviewed — ready to submit";
  if (from === "ready_to_submit" && to === "draft") return "Sent back to draft";
  if (to === "paid") return `Recorded as paid in full${amount}`;
  if (to === "partially_paid") return `Recorded as partially paid${amount}`;
  if (to === "denied") return "Recorded as denied by the payer";
  if (to === "voided") return "Voided";
  return `Status changed ${from} → ${to}`;
}

export interface MarkStatusArgs {
  orgId: string;
  id: string;
  to: SuperbillStatus;
  paidAmountCents?: number;
  /** Recorded on the activity trail so the history names who acted. */
  actorUserId?: string;
  /**
   * Submit although the payer's documentation standard says the note lacks
   * something (audit R19). The reason is kept on the claim history.
   */
  documentationOverride?: { reason: string };
  /**
   * The caller has looked at both figures and says the payer really did pay
   * more than this claim billed. Without it, a typed payment over the billed
   * amount is refused — see the bound in markStatusTx.
   */
  overpaymentAcknowledged?: boolean;
  /**
   * The caller is recording this payment as covering the WHOLE bill — the
   * confirm it showed the biller said so. Checked here against what the claim
   * actually bills, because the caller compared against a screen's own figure
   * and that figure goes stale — see the check in markStatusTx.
   */
  paidInFull?: boolean;
  /** Set when a payer's 835 drives the move (audit R10). See StatusSource. */
  source?: StatusSource;
}

export async function markStatus(
  args: MarkStatusArgs,
): Promise<{ from: SuperbillStatus; to: SuperbillStatus }> {
  return withOrgContext(args.orgId, (tx) => markStatusTx(tx, args));
}

/**
 * markStatus inside a transaction the caller already holds. Remittance
 * posting (audit R10) applies up to two moves to a claim (submitted, then
 * paid) in the one transaction it opens per claim, so it cannot let each move
 * open its own. Everything a person's click gets happens here either way.
 */
export async function markStatusTx(
  tx: Tx,
  args: MarkStatusArgs,
): Promise<{ from: SuperbillStatus; to: SuperbillStatus }> {
  // FOR UPDATE: serialize concurrent transitions on the same superbill —
  // check-then-update without the lock could apply two conflicting moves.
  const rows = await tx.$queryRaw<
    { status: SuperbillStatus; provider_npi: string | null; visit_id: string | null }[]
  >`
    SELECT status, provider_npi, visit_id FROM superbill
     WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
     LIMIT 1 FOR UPDATE
  `;
  const from = rows[0]?.status;
  if (!from) throw new NotFoundError("Superbill not found.");
  if (!STATUS_TRANSITIONS[from].includes(args.to)) {
    throw new ValidationError(`Illegal superbill transition ${from} → ${args.to}.`);
  }
  // A claim naming no rendering provider is rejected by every payer, so it
  // must not leave here marked as submitted (audit R40). Recording the
  // clinician's NPI on the Team page fills it into their open bills.
  if (args.to === "submitted" && !(rows[0]!.provider_npi ?? "").trim()) {
    throw new ValidationError(
      "This claim has no rendering-provider NPI, so a payer would reject it. Record the clinician's NPI on the Team page — it fills into their open bills — then submit.",
    );
  }
  // A typed payment was bounded by nothing on this claim: the route caps it at
  // an absolute $1,000,000 and nothing compared it to what the claim billed. So
  // a cents/dollars slip — 5000 typed for $50.00 on a $150.00 claim — wrote
  // $5,000.00 to paid_amount_cents, and /billing then reported $5,000 collected
  // against $150 billed with Outstanding negative. The claim is the bound.
  //
  // Not a hard ceiling: payers do pay more than billed (a duplicate payment,
  // prompt-pay interest), and a claim whose payment cannot be recorded is just
  // as wrong in the other direction. So an overpayment is recordable by saying
  // it is one, and the trail and the audit row then carry that it was.
  //
  // Only for an amount a person typed. An amount from a payer's 835 (audit R10)
  // is the payer's own word: refusing it would drop money the payer really
  // sent, and the posting already records where the figure came from.
  let overpayment: { billedAmountCents: number } | null = null;
  if (
    (args.to === "paid" || args.to === "partially_paid") &&
    !args.source &&
    args.paidAmountCents !== undefined
  ) {
    // A second read rather than a column on the lock SELECT above: that row is
    // already locked, so this sees the same claim and cannot race a concurrent
    // move.
    const billedRows = await tx.$queryRaw<{ billed_amount_cents: bigint | number }[]>`
      SELECT billed_amount_cents FROM superbill WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    const billed = Number(billedRows[0]?.billed_amount_cents ?? 0);
    // A payment recorded as covering the WHOLE bill has to actually cover it,
    // measured against the claim rather than against the screen that said so.
    // The queue derives "this covers the bill" from its own fetched row —
    // "Record paid in full" posts that row's billed figure, and a typed amount
    // that reaches it is recorded as paid instead of partial — and that row
    // goes stale: updateSuperbill lets a denied claim be edited and repriced
    // UP (repriceSuperbill) and resubmitted in another tab, leaving an open
    // queue holding the older, LOWER billed amount. Without this check, typing
    // an amount that covered the stale figure wrote status 'paid' on a claim
    // billing more — and STATUS_TRANSITIONS.paid is [], so the rest of the
    // payment could never be recorded, under a trail line reading "Recorded as
    // paid in full".
    //
    // Only for a caller that makes that claim. A payment short of the bill is
    // otherwise perfectly ordinary — a contractual adjustment closes most
    // claims for less than they billed — so this refuses the assertion, never
    // the amount.
    if (args.paidInFull && billed > 0 && args.paidAmountCents < billed) {
      throw new ValidationError(
        `$${(args.paidAmountCents / 100).toFixed(2)} does not cover the $${(billed / 100).toFixed(2)} this claim bills, so it cannot be recorded as paid in full: paid is a final status, and the remaining $${((billed - args.paidAmountCents) / 100).toFixed(2)} could never be recorded. Reload the queue and record the payment against what the claim bills now.`,
      );
    }
    // An unpriced claim (billed_amount_cents defaults to 0) offers nothing to
    // compare against; bounding a payment by 0 would refuse every one of them.
    if (billed > 0 && args.paidAmountCents > billed) {
      if (!args.overpaymentAcknowledged) {
        // Said in the passive, because nobody necessarily typed this figure.
        // The queue's "Record paid in full" posts the row's own billed amount,
        // and a claim repriced in another tab (updateSuperbill → repriceSuperbill)
        // leaves that row stale and high — so "Enter the amount in dollars and
        // cents" was advice about a number the biller never entered.
        throw new ValidationError(
          `That records $${(args.paidAmountCents / 100).toFixed(2)} paid on a claim billed $${(billed / 100).toFixed(2)}. Amounts are recorded in dollars and cents, so $50.00 is 50.00, not 5000. If the payer really did pay more than the claim billed, confirm it as an overpayment.`,
        );
      }
      // A payment above the bill is not a partial one. Recorded as one it
      // wrote a trail line contradicting itself — "Recorded as partially paid
      // — $5000.00 — more than the $150.00 billed" — left the claim in the
      // queue's "partially paid" filter, and stayed in /billing's Outstanding,
      // which sums billed − paid over submitted and partially_paid claims and
      // so went negative by the excess.
      if (args.to === "partially_paid") {
        throw new ValidationError(
          `$${(args.paidAmountCents / 100).toFixed(2)} is more than the $${(billed / 100).toFixed(2)} this claim billed, so it is not a partial payment. Record it as paid, confirming the overpayment there.`,
        );
      }
      overpayment = { billedAmountCents: billed };
    }
  }

  // The payer's documentation standard against the signed note (audit R19).
  // A claim the payer's own manual says the note does not support stops
  // here, rather than surfacing on a record review a year later. A biller
  // who knows it is documented elsewhere (an addendum, a referral) submits
  // with a reason, which the claim history keeps.
  //
  // A move posted from a payer's 835 (audit R10) is read against the same
  // standard but never stopped: the gate stops a claim going out, and the
  // payer has already processed this one. The gap is not dropped either. It
  // goes on the trail and in the audit row as element names, so a claim that
  // went out undocumented still shows it before a record review finds it.
  let overridden: { missing: string[]; reason: string } | null = null;
  let remittanceGap: string[] | null = null;
  if (args.to === "submitted") {
    const docs = await loadDocumentationGaps(tx, { superbillId: args.id });
    const gap = documentationGap(docs.results, docs.payerName);
    if (gap && args.source) {
      remittanceGap = gap.missing.map((m) => m.element);
    } else if (gap) {
      const reason = args.documentationOverride?.reason.trim();
      if (!reason) throw new DocumentationIncompleteError(gap);
      overridden = { missing: gap.missing.map((m) => m.element), reason };
    }
  }

  if (args.to === "submitted") {
    await tx.$executeRaw`
      UPDATE superbill SET status = 'submitted', submitted_at = now(), updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    // Close out the visit too. Submitting the claim is the moment the visit
    // is genuinely billed; without this nothing ever left 'pending_billing',
    // so the claims queue never drained and it kept listing visits whose
    // claims had already been paid. Guarded on the current status so a
    // refile (denied → submitted) doesn't re-fire on an already-billed visit.
    await tx.$executeRaw`
      UPDATE visit SET status = 'billed', updated_at = now()
      WHERE id = (SELECT visit_id FROM superbill WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid)
        AND org_id = ${args.orgId}::uuid
        AND status = 'pending_billing'
    `;
  } else if (args.to === "paid" || args.to === "partially_paid") {
    // paid_source says whose word the amount is (audit R10): the payer's 835,
    // or what the team typed. The dashboard reports the two apart.
    await tx.$executeRaw`
      UPDATE superbill SET
        status = ${args.to},
        paid_at = now(),
        paid_amount_cents = ${args.paidAmountCents ?? null},
        paid_source = ${args.source ? "remittance" : "recorded"},
        updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
  } else {
    await tx.$executeRaw`
      UPDATE superbill SET status = ${args.to}, updated_at = now()
      WHERE id = ${args.id}::uuid AND org_id = ${args.orgId}::uuid
    `;
    // Marking a claim denied from the queue used to change superbill.status
    // and nothing else. Every denial metric that reads superbill_denial —
    // the denial rate, the by-payer breakdown, the reason analysis, the whole
    // "where those denials were" question the client asked for — therefore
    // counted zero no matter how many claims were denied, because the only
    // writer of that table was the full log-a-denial flow nobody used from
    // here.
    //
    // The queue's one-click Record denial has no CARC to record: the biller is
    // looking at a status, not an EOB. So the row is created UNCODED and the
    // reason is asked for afterwards. Recording the denial without its reason
    // is right — the denial is a fact, the reason is detail — and a count
    // that is correct with some reasons missing beats a count that is zero.
    //
    // A denial from a payer's 835 (audit R10) carries its own CARC, which
    // remittance.service records; an UNCODED row here would count it twice.
    if (args.to === "denied" && !args.source) {
      await tx.$executeRaw`
        INSERT INTO superbill_denial (
          org_id, superbill_id, payer_id, cpt_code, icd10_codes, modifiers,
          carc_code, denial_reason, denied_amount_cents, denied_at
        )
        SELECT ${args.orgId}::uuid, s.id, s.payer_id,
               COALESCE(s.cpt_codes[1], '—'),
               COALESCE(s.icd10_codes, ARRAY[]::text[]),
               COALESCE(s.modifiers, ARRAY[]::text[]),
               'UNCODED',
               'Marked denied from the claims queue. The payer reason code has not been recorded yet.',
               COALESCE(s.billed_amount_cents, 0), now()
          FROM superbill s
         WHERE s.id = ${args.id}::uuid
           AND s.org_id = ${args.orgId}::uuid
           -- Re-denial after a refile must not double-count the same claim.
           AND NOT EXISTS (
             SELECT 1 FROM superbill_denial d WHERE d.superbill_id = s.id
           )
      `;
    }
  }

  const fromRemittance = args.source
    ? { source: "remittance", remittanceFileId: args.source.remittanceFileId }
    : {};

  // Append to the trail inside the same transaction — a status change that
  // isn't recorded would leave an unexplained gap in an appeal.
  //
  // clock_timestamp(), not the column's now() default. A remittance posting
  // (audit R10) records submitted, then paid, for one claim in one
  // transaction; now() is the transaction's start, so both entries got the
  // same `at` and the trail could list "Paid" before "Submission confirmed".
  await tx.$executeRaw`
    INSERT INTO superbill_activity (
      org_id, superbill_id, actor_user_id, kind, from_status, to_status, summary, detail, at
    ) VALUES (
      ${args.orgId}::uuid, ${args.id}::uuid, ${args.actorUserId ?? null}::uuid,
      ${from === "denied" && args.to === "submitted" ? "resubmitted" : "status_change"},
      ${from}, ${args.to},
      ${
        statusSummary(from, args.to, args.paidAmountCents, args.source) +
        (overridden
          ? ` — over a documentation gap (${overridden.missing.map(elementLabel).join(", ")}): ${overridden.reason}`
          : "") +
        (remittanceGap ? ` — with a documentation gap (${remittanceGap.map(elementLabel).join(", ")})` : "") +
        // Says on the claim's own history that the figure is above the claim,
        // so a payment larger than the bill is never read as an ordinary one.
        (overpayment
          ? ` — more than the $${(overpayment.billedAmountCents / 100).toFixed(2)} billed, confirmed as an overpayment`
          : "")
      },
      ${JSON.stringify({
        ...(args.paidAmountCents !== undefined ? { paidAmountCents: args.paidAmountCents } : {}),
        ...(overridden ? { documentationOverride: overridden } : {}),
        ...(remittanceGap ? { documentationGap: remittanceGap } : {}),
        ...(overpayment ? { overpayment } : {}),
        ...fromRemittance,
      })}::jsonb,
      clock_timestamp()
    )
  `;

  // The claim lifecycle in the audit log too (audit R24). superbill_activity
  // is the claim's own history, but an org admin reading a visit's audit
  // trail saw its claim created and then nothing: never submitted, paid or
  // denied. Ids and statuses only; the override reason is free text and
  // stays on the claim history. A posting from an 835 says so (audit R10),
  // and names any documentation gap it went through as element keys (R19).
  await writeAudit(tx, {
    orgId: args.orgId,
    userId: args.actorUserId ?? null,
    action: "superbill_status_change",
    targetType: "superbill",
    targetId: args.id,
    payload: {
      from,
      to: args.to,
      visitId: rows[0]!.visit_id,
      ...(args.paidAmountCents !== undefined ? { paidAmountCents: args.paidAmountCents } : {}),
      ...(overridden ? { documentationOverride: overridden.missing } : {}),
      ...(remittanceGap ? { documentationGap: remittanceGap } : {}),
      // The fact, recorded so /audit has it. The whitelist in
      // summarizeAuditPayload (lib/features/audit/audit-pure.ts) reads this
      // key's billedAmountCents and appends "· more than the $101.79 billed,
      // confirmed as an overpayment" — the row used to read "submitted → paid
      // · paid $5000.00" with nothing saying it exceeded the bill, on the one
      // screen an auditor reads to find that. Keep the shape
      // { billedAmountCents } or that line silently stops printing. The claim's
      // own history and the superbill queue, whose Paid column marks any
      // payment above the bill "· more than billed"
      // (app/(platform)/billing/superbills/page.tsx), say so too.
      ...(overpayment ? { overpayment } : {}),
      ...fromRemittance,
    },
  });
  return { from, to: args.to };
}

export interface SuperbillActivityView {
  id: string;
  at: string;
  actorName: string | null;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  summary: string;
  detail: Record<string, unknown>;
}

/** Full append-only trail for one superbill, newest first. */
export async function listSuperbillActivity(args: {
  orgId: string;
  superbillId: string;
}): Promise<SuperbillActivityView[]> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        at: Date;
        actor_name: string | null;
        kind: string;
        from_status: string | null;
        to_status: string | null;
        summary: string;
        detail: Record<string, unknown> | null;
      }[]
    >`
      SELECT a.id, a.at, COALESCE(u.full_name, u.email) AS actor_name,
             a.kind, a.from_status, a.to_status, a.summary, a.detail
      FROM superbill_activity a
      LEFT JOIN app_user u ON u.id = a.actor_user_id
      WHERE a.superbill_id = ${args.superbillId}::uuid
        AND a.org_id = ${args.orgId}::uuid
      ORDER BY a.at DESC, a.id DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorName: r.actor_name,
      kind: r.kind,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      summary: r.summary,
      detail: r.detail ?? {},
    }));
  });
}
