/**
 * Superbill pure helpers — derive a billable artifact from a visit.
 *
 * No DB. The service layer reads the visit + patient, hands the data
 * here, and persists the result.
 *
 * Source: pallio_complete_vision_v3 §6.5 (superbill structure) + §5.3
 * (rate table).
 */

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
  G0318: { md: 2497, npPa: 2938 },
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

export interface BuildSuperbillInput {
  visit: {
    id: string;
    patientId: string;
    isTelehealth: boolean;
    cptCodesAssigned: string[];
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
    npi: string;
    fullName: string;
    /** Drives MD vs NP/PA rates. */
    tier: ProviderTier;
  };
  /** Place-of-service code: 12 (home) is the palliative default. */
  placeOfServiceCode?: string;
}

export interface DraftSuperbill {
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
  /** Sum of estimateRateCents() across CPT codes — informational. */
  billedAmountCents: number;
  /** Codes that hit the rate table. */
  ratedCodes: { code: string; rateCents: number }[];
  /** Codes the platform doesn't have a rate for (org rulebook may set them). */
  unratedCodes: string[];
  warnings: string[];
}

/**
 * Build a draft superbill from a visit + patient + provider. Pure: no
 * IO. The caller persists with `superbill.service.ts`.
 */
export function buildSuperbill(input: BuildSuperbillInput): DraftSuperbill {
  const { visit, patient, provider } = input;
  const placeOfServiceCode =
    input.placeOfServiceCode ?? (visit.isTelehealth ? "10" : "12");

  const rated: DraftSuperbill["ratedCodes"] = [];
  const unrated: string[] = [];
  let total = 0;

  for (const code of visit.cptCodesAssigned) {
    const cents = estimateRateCents(code, provider.tier);
    if (cents > 0) {
      rated.push({ code, rateCents: cents });
      total += cents;
    } else {
      unrated.push(code);
    }
  }

  const warnings: string[] = [];
  if (!patient.primaryMemberId) {
    warnings.push("Patient has no primary member ID — claim will be rejected.");
  }
  if (visit.cptCodesAssigned.length === 0) {
    warnings.push("Visit has no CPT codes — confirm with clinician.");
  }
  if (visit.icd10Codes.length === 0) {
    warnings.push("Visit has no ICD-10 codes — claim needs at least one.");
  }
  if (visit.isTelehealth && !visit.modifiers.includes("95") && !visit.modifiers.includes("93")) {
    warnings.push("Telehealth visit missing modifier 95 (audio+video) or 93 (audio-only).");
  }
  if (unrated.length > 0) {
    warnings.push(
      `Codes without rate-table entry: ${unrated.join(", ")} — verify with payer rulebook.`,
    );
  }

  return {
    visitId: visit.id,
    patientId: patient.id,
    payerId: patient.primaryPayerId,
    memberIdSnapshot: patient.primaryMemberId ?? "",
    dateOfService: visit.dos,
    cptCodes: visit.cptCodesAssigned,
    icd10Codes: visit.icd10Codes,
    modifiers: visit.modifiers,
    providerNpi: provider.npi,
    providerName: provider.fullName,
    placeOfServiceCode,
    billedAmountCents: total,
    ratedCodes: rated,
    unratedCodes: unrated,
    warnings,
  };
}
