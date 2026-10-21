/**
 * Superbill pure helpers — derive a billable artifact from a visit.
 *
 * No DB. The service layer reads the visit + patient, hands the data
 * here, and persists the result.
 *
 * Source: pallio_complete_vision_v3 §6.5 (superbill structure) + §5.3
 * (rate table).
 */
import {
  normalizeUnits,
  unitWarnings,
  unitsOf,
  type CodeUnits,
} from "@/lib/features/billing/code-units";
import { providerIdentityWarnings, type NpiSource } from "@/lib/features/team/clinician";
import {
  ESTABLISHED_PATIENT_HOME_CODES,
  NEW_PATIENT_HOME_CODES,
} from "@/lib/features/visits/cpt-suggester";
import {
  defaultPosFor,
  posLabel,
  posTelehealthConflict,
} from "@/lib/features/visits/place-of-service";

/**
 * 2025 Medicare allowable rates (§5.3). When a payer is non-Medicare we
 * still use these as the FE billed-amount hint; the actual contracted
 * rate is set in the per-org rulebook (Phase 5).
 */
const MEDICARE_RATES_CENTS_2025: Record<
  string,
  { md: number; npPa: number }
> = {
  // New patient home (§5.3 table)
  "99341": { md: 4664, npPa: 3964 },
  "99342": { md: 7411, npPa: 6299 },
  "99344": { md: 13413, npPa: 11401 },
  "99345": { md: 18994, npPa: 16145 },
  // Established patient home
  "99347": { md: 4277, npPa: 3635 },
  "99348": { md: 7218, npPa: 6135 },
  "99349": { md: 11975, npPa: 10179 },
  "99350": { md: 17452, npPa: 14834 },
  // Prolonged service (Medicare uses G0318)
  // MD above NP/PA, as in every other row. These were swapped, so a
  // physician's prolonged service billed less than an NP's (audit R33).
  G0318: { md: 2938, npPa: 2497 },
  // Non-Medicare prolonged service
  "99417": { md: 2919, npPa: 2475 },
  // ACP
  "99497": { md: 7660, npPa: 6381 },
  "99498": { md: 7184, npPa: 5984 },
};

export type ProviderTier = "MD" | "NP_PA";

/**
 * Estimate billed amount in cents for a CPT/HCPCS code given the
 * provider tier. Returns 0 if the code isn't in the rate table —
 * caller should surface that as "verify rate" rather than $0.
 */
export function estimateRateCents(code: string, tier: ProviderTier): number {
  const r = MEDICARE_RATES_CENTS_2025[code];
  if (!r) return 0;
  return tier === "MD" ? r.md : r.npPa;
}

/** A payer's rate on file for one code on the date of service (payer_rule 'covered'). */
export interface PayerRate {
  code: string;
  /** The published rate — the physician, non-facility figure. */
  rateCents: number;
  /** An NP/PA rate, where the schedule publishes one (SC Medicaid does). */
  npPaRateCents: number | null;
  /** A facility rate, for places of service the POS table marks facility. */
  facilityRateCents: number | null;
  payerRuleId: string;
  rateBasis: string | null;
  /** ISO date the rate took effect. */
  effectiveDate: string;
}

export type PriceSource = "payer_fee_schedule" | "reference_table" | "unrated";

/** One billed code, its price, and where the price came from (audit R33). */
export interface PricedLine {
  code: string;
  /** The rate for ONE unit. 0 when unrated. */
  rateCents: number;
  /**
   * Units billed on this line (0106), and the line's charge: rateCents ×
   * units. priceCodes always sets both; they are optional because pricing
   * saved before 0106 carries neither, so read the charge with lineChargeCents.
   */
  units?: number;
  chargeCents?: number;
  source: PriceSource;
  payerRuleId: string | null;
  rateBasis: string | null;
  effectiveDate: string | null;
}

/** What a line charges: its stored charge, else one rate per unit (one unit on lines saved before 0106). */
export function lineChargeCents(l: PricedLine): number {
  return l.chargeCents ?? l.rateCents * (l.units ?? 1);
}

/** Stored on the bill as superbill.pricing. */
export interface SuperbillPricing {
  tier: ProviderTier;
  lines: PricedLine[];
}

/**
 * Price each code (audit R33): the payer's rate on file first, then Pallio's
 * 2025 Medicare reference table, otherwise unrated.
 *
 * Every claim used to be priced from the reference table alone, whatever the
 * payer — the superbill page showed UnitedHealthcare Ohio's $70.13 for 99349
 * in its rule check and billed $101.79 on the same screen. Where the payer
 * publishes an NP/PA or a facility rate it is used; otherwise its published
 * (physician) rate is, which never bills below what the payer allows.
 *
 * Every rate is per unit — the payer's schedule and the reference table
 * alike — so a line charges rate × units (0106). The units are normalized
 * first: only a per-increment add-on (G0318, 99417, 99498) is ever priced at
 * more than one, whatever map the caller passes.
 *
 * Each code is priced once, however often it is listed. The codes are a set
 * everywhere they are printed or compared (formatCodes, the packet's
 * reconcile), but a code sent twice through the API was priced twice: with
 * units that billed G0318 × 8 beside a bill that printed "G0318 ×4".
 */
export function priceCodes(
  codes: string[],
  tier: ProviderTier,
  payerRates: PayerRate[] = [],
  opts: { facility?: boolean; units?: CodeUnits | null } = {},
): { lines: PricedLine[]; totalCents: number; unrated: string[]; fromReference: string[] } {
  const byCode = new Map(payerRates.map((r) => [r.code, r]));
  const perCode = normalizeUnits(codes, opts.units);
  const lines: PricedLine[] = [];
  const unrated: string[] = [];
  const fromReference: string[] = [];
  let totalCents = 0;
  for (const code of new Set(codes)) {
    const units = unitsOf(perCode, code);
    const pr = byCode.get(code);
    if (pr) {
      const cents =
        opts.facility && pr.facilityRateCents !== null
          ? pr.facilityRateCents
          : tier === "NP_PA" && pr.npPaRateCents !== null
            ? pr.npPaRateCents
            : pr.rateCents;
      lines.push({
        code,
        rateCents: cents,
        units,
        chargeCents: cents * units,
        source: "payer_fee_schedule",
        payerRuleId: pr.payerRuleId,
        rateBasis: pr.rateBasis,
        effectiveDate: pr.effectiveDate,
      });
      totalCents += cents * units;
      continue;
    }
    const ref = estimateRateCents(code, tier);
    if (ref > 0) {
      lines.push({
        code,
        rateCents: ref,
        units,
        chargeCents: ref * units,
        source: "reference_table",
        payerRuleId: null,
        rateBasis: null,
        effectiveDate: null,
      });
      totalCents += ref * units;
      fromReference.push(code);
      continue;
    }
    lines.push({
      code,
      rateCents: 0,
      units,
      chargeCents: 0,
      source: "unrated",
      payerRuleId: null,
      rateBasis: null,
      effectiveDate: null,
    });
    unrated.push(code);
  }
  return { lines, totalCents, unrated, fromReference };
}

const RATE_BASIS_LABEL: Record<string, string> = {
  state_medicaid_ffs_non_facility_benchmark: "state Medicaid fee schedule (non-facility)",
  cms_pfs_national_non_facility: "Medicare physician fee schedule, national (non-facility)",
  sc_medicaid_ffs_base_physicians_schedule: "SC Medicaid physician fee schedule",
};

/** Where a line's price came from, in words for the bill page. */
export function describePriceSource(line: PricedLine): string {
  if (line.source === "payer_fee_schedule") {
    const basis = line.rateBasis ? (RATE_BASIS_LABEL[line.rateBasis] ?? line.rateBasis) : "fee schedule";
    return `payer rate — ${basis}${line.effectiveDate ? `, effective ${line.effectiveDate}` : ""}`;
  }
  if (line.source === "reference_table") {
    return "Pallio's 2025 Medicare reference table — verify with the payer";
  }
  return "no rate on file — set the charge";
}

export interface BuildSuperbillInput {
  visit: {
    id: string;
    patientId: string;
    isTelehealth: boolean;
    cptCodesAssigned: string[];
    /** Units per code when more than one (visit.cpt_units, 0106); absent = one each. */
    cptUnits?: CodeUnits | null;
    icd10Codes: string[];
    modifiers: string[];
    /** ISO date — visit DOS. */
    dos: string;
  };
  patient: {
    id: string;
    primaryPayerId: string | null;
    primaryMemberId: string | null;
  };
  provider: {
    /** Rendering provider NPI (CMS-1500 box 24J): the clinician, not the org. */
    npi: string;
    fullName: string;
    /** Drives MD vs NP/PA rates. */
    tier: ProviderTier;
    /** Billing provider NPI (box 33a): the organization, from onboarding. */
    billingNpi?: string;
    /** Where `npi` came from, so a fallback is never silent (audit R40). */
    npiSource?: NpiSource;
    /** Licensure from clinician_profile; undefined means not looked up. */
    credential?: string | null;
  };
  /**
   * Where the visit took place, as recorded on the visit (audit R23). Absent
   * or null means not recorded: the telehealth default is used, and the draft
   * says so.
   */
  placeOfServiceCode?: string | null;
  /** The payer's rates on file for the date of service (audit R33). */
  payerRates?: PayerRate[];
  /** The place of service is a facility (POS table), for the facility rate. */
  posFacility?: boolean;
}

export interface DraftSuperbill {
  visitId: string;
  patientId: string;
  payerId: string | null;
  memberIdSnapshot: string;
  dateOfService: string;
  cptCodes: string[];
  /** Units per code when more than one, normalized (superbill.cpt_units, 0106). */
  cptUnits: CodeUnits;
  icd10Codes: string[];
  modifiers: string[];
  providerNpi: string;
  providerName: string;
  /** Billing provider NPI (box 33a). */
  billingNpi: string;
  placeOfServiceCode: string;
  /** Sum of the priced lines, units × rate each. */
  billedAmountCents: number;
  /** Codes with a price, and where each price came from. */
  ratedCodes: PricedLine[];
  /** Codes the platform doesn't have a rate for (org rulebook may set them). */
  unratedCodes: string[];
  warnings: string[];
  /** Stored on the bill as superbill.pricing (audit R33). */
  pricing: SuperbillPricing;
}

const WARN_NO_MEMBER_ID = "Patient has no primary member ID — claim will be rejected.";
const WARN_NO_CPT = "Visit has no CPT codes — confirm with clinician.";
const WARN_NO_ICD10 = "Visit has no ICD-10 codes — claim needs at least one.";

/**
 * Build a draft superbill from a visit + patient + provider. Pure: no
 * IO. The caller persists with `superbill.service.ts`.
 */
export function buildSuperbill(input: BuildSuperbillInput): DraftSuperbill {
  const { visit, patient, provider } = input;
  const recordedPos = input.placeOfServiceCode?.trim() || null;
  const placeOfServiceCode = recordedPos ?? defaultPosFor(visit.isTelehealth);

  // The payer's rate first, then the reference table, then unrated (R33),
  // each times the units the visit recorded (0106).
  const cptUnits = normalizeUnits(visit.cptCodesAssigned, visit.cptUnits);
  const priced = priceCodes(visit.cptCodesAssigned, provider.tier, input.payerRates ?? [], {
    facility: input.posFacility,
    units: cptUnits,
  });
  const rated = priced.lines.filter((l) => l.source !== "unrated");
  const unrated = priced.unrated;
  const total = priced.totalCents;

  const warnings: string[] = [];
  if (!patient.primaryMemberId) warnings.push(WARN_NO_MEMBER_ID);
  if (visit.cptCodesAssigned.length === 0) warnings.push(WARN_NO_CPT);
  if (visit.icd10Codes.length === 0) warnings.push(WARN_NO_ICD10);
  if (visit.isTelehealth && !visit.modifiers.includes("95") && !visit.modifiers.includes("93")) {
    warnings.push("Telehealth visit missing modifier 95 (audio+video) or 93 (audio-only).");
  }
  if (priced.fromReference.length > 0) {
    warnings.push(
      patient.primaryPayerId
        ? `No rate on file with this payer for ${priced.fromReference.join(", ")} — priced from Pallio's 2025 Medicare reference table. Verify before submitting.`
        : `No payer on file — ${priced.fromReference.join(", ")} priced from Pallio's 2025 Medicare reference table. Verify before submitting.`,
    );
  }
  if (unrated.length > 0) {
    warnings.push(
      `No rate for ${unrated.join(", ")} with this payer or in Pallio's reference table — set the charge before submitting.`,
    );
  }
  // Where the visit took place is never silently inferred (audit R23).
  if (!recordedPos) {
    warnings.push(
      `Place of service was not recorded on the visit — defaulted to ${posLabel(placeOfServiceCode)}. Confirm where the visit took place.`,
    );
  }
  const posConflict = posTelehealthConflict(placeOfServiceCode, visit.isTelehealth);
  if (posConflict) warnings.push(posConflict);
  // Who the claim names: rendering NPI present, real, and the clinician's own
  // rather than the organization fallback; credential recorded and billable.
  warnings.push(...providerIdentityWarnings(provider));
  // G0318 above Pallio's per-visit cap (0106).
  warnings.push(...unitWarnings(visit.cptCodesAssigned, cptUnits));

  return {
    visitId: visit.id,
    patientId: patient.id,
    payerId: patient.primaryPayerId,
    memberIdSnapshot: patient.primaryMemberId ?? "",
    dateOfService: visit.dos,
    cptCodes: visit.cptCodesAssigned,
    cptUnits,
    icd10Codes: visit.icd10Codes,
    modifiers: visit.modifiers,
    providerNpi: provider.npi,
    providerName: provider.fullName,
    billingNpi: provider.billingNpi ?? "",
    placeOfServiceCode,
    billedAmountCents: total,
    ratedCodes: rated,
    unratedCodes: unrated,
    warnings,
    pricing: { tier: provider.tier, lines: priced.lines },
  };
}

/**
 * Warnings for a bill that has already been saved.
 *
 * A draft's warnings are computed when it is built and never stored, so the
 * superbill screen showed a saved bill with none at all — even one carrying no
 * NPI or no member ID. These are the checks the saved row alone can answer.
 * `billingNpi` is null on bills saved before the billing NPI was recorded.
 */
export function savedSuperbillWarnings(sb: {
  memberIdSnapshot: string;
  cptCodes: string[];
  icd10Codes: string[];
  providerNpi: string;
  providerName: string;
  billingNpi?: string | null;
  /** Units per code (0106); absent on bills saved before it. */
  cptUnits?: CodeUnits | null;
}): string[] {
  const out: string[] = [];
  if (!sb.memberIdSnapshot) out.push(WARN_NO_MEMBER_ID);
  if ((sb.cptCodes ?? []).length === 0) out.push(WARN_NO_CPT);
  if ((sb.icd10Codes ?? []).length === 0) out.push(WARN_NO_ICD10);
  out.push(
    ...providerIdentityWarnings({
      npi: sb.providerNpi ?? "",
      fullName: sb.providerName ?? "",
      billingNpi: sb.billingNpi ?? undefined,
    }),
  );
  out.push(...unitWarnings(sb.cptCodes ?? [], sb.cptUnits));
  return out;
}

/**
 * A stamp for a printed bill nobody has reviewed yet (audit R26). A draft PDF
 * could otherwise pass for the claim that went out.
 */
export function submissionStamp(status: string): string | null {
  return status === "draft" ? "DRAFT — not reviewed for submission" : null;
}

/** The home-visit E/M codes, new patient and established. */
const HOME_VISIT_CODES = new Set<string>([...NEW_PATIENT_HOME_CODES, ...ESTABLISHED_PATIENT_HOME_CODES]);

/**
 * A bill's codes with `code` as its home-visit E/M code: in the place of the
 * one already on it, or added when it has none. A home visit bills one E/M
 * code per date of service, and the bill page's "Use this code" added its
 * suggestion beside the visit's own, so one click turned 99342 + 99497 into
 * 99342 + 99497 + 99349.
 */
export function withHomeVisitCode(codes: readonly string[], code: string): string[] {
  const at = codes.findIndex((c) => HOME_VISIT_CODES.has(c));
  if (at === -1) return [...codes, code];
  return codes.flatMap((c, i) => (i === at ? [code] : HOME_VISIT_CODES.has(c) ? [] : [c]));
}
