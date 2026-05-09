/**
 * CPT code suggester — pure decision tree.
 *
 * Source: pallio_complete_vision_v3 §18.8.
 *
 * Given a visit's type, total time, and the documented ACP minutes,
 * returns a list of suggested CPT codes (and the reasoning for each).
 * The clinician sees these inline at the moment they save the visit
 * (not after the fact) — vision §5.2 + §6.4.
 *
 * Important properties:
 *   - PURE. No DB, no fetch, no env. Trivially unit-tested. Same input → same output.
 *   - The function NEVER suggests a code without crossing a clear time
 *     threshold. When the visit is ambiguous (e.g. exactly at a boundary
 *     ± 1 min), the suggester emits a `confidence: 'edge'` flag so the
 *     UI can prompt the clinician to confirm before submitting.
 *   - Medicare prolonged-service add-on uses G0318; non-Medicare uses
 *     99417. The orchestrator picks based on the resolved payer.
 *   - ACP minutes are tracked separately from base visit minutes so
 *     99497/99498 stack on top of the base code without double-count.
 *
 * Cheat-sheet: see § "5.3 CPT Code Intelligence" in the vision doc for
 * the canonical rate table — this file owns ONLY the boundary logic.
 */

export type VisitType =
  | "new_patient_home"
  | "established_patient_home"
  | "advance_care_planning"
  | "telehealth"
  | "inpatient_consult";

export type ProviderType = "MD" | "NP" | "PA" | "RN" | "SW" | "OTHER";

export type PayerCategory = "medicare" | "non_medicare";

export interface SuggestVisitInput {
  visitType: VisitType;
  /** Total documented visit minutes (excluding ACP). */
  totalMinutes: number;
  /** Minutes spent on advance-care-planning specifically. */
  acpMinutes?: number;
  providerType: ProviderType;
  /** Drives G0318 (Medicare) vs 99417 (non-Medicare) prolonged-service code. */
  payerCategory: PayerCategory;
  /** Telehealth modality affects the modifier suggestion (vision §5.2). */
  isTelehealth?: boolean;
}

export type SuggestionConfidence = "edge" | "confirmed";

export interface CodeSuggestion {
  code: string;
  /** A short reason for the analyst — never user-facing copy alone. */
  reason: string;
  /** `edge` when at a boundary; ask clinician to confirm. */
  confidence: SuggestionConfidence;
  /** Total minutes attributed to THIS code (informational). */
  attributedMinutes?: number;
}

export interface ModifierSuggestion {
  modifier: string;
  reason: string;
}

export interface CptSuggestion {
  base: CodeSuggestion[];
  prolongedAddOns: CodeSuggestion[];
  acpAddOns: CodeSuggestion[];
  modifiers: ModifierSuggestion[];
  /** True if no code can be suggested confidently — clinician must pick. */
  inconclusive: boolean;
}

// ---------------------------------------------------------------------------
// Time thresholds (per §18.8 table)
// ---------------------------------------------------------------------------

interface ThresholdBand {
  /** Inclusive lower bound, in minutes. */
  minMinutes: number;
  /** Inclusive upper bound, in minutes. `Infinity` for the top band. */
  maxMinutes: number;
  code: string;
}

const NEW_PATIENT_HOME_BANDS: ThresholdBand[] = [
  { minMinutes: 0, maxMinutes: 19, code: "99341" },
  { minMinutes: 20, maxMinutes: 44, code: "99342" },
  { minMinutes: 45, maxMinutes: 59, code: "99344" },
  { minMinutes: 60, maxMinutes: Infinity, code: "99345" },
];

const ESTABLISHED_PATIENT_HOME_BANDS: ThresholdBand[] = [
  { minMinutes: 0, maxMinutes: 24, code: "99347" },
  { minMinutes: 25, maxMinutes: 34, code: "99348" },
  { minMinutes: 35, maxMinutes: 59, code: "99349" },
  { minMinutes: 60, maxMinutes: Infinity, code: "99350" },
];

/** Top-of-band threshold past which prolonged service applies. */
const NEW_PATIENT_TOP_THRESHOLD = 75;
const ESTABLISHED_PATIENT_TOP_THRESHOLD = 60;

const PROLONGED_INCREMENT_MINUTES = 15;
const PROLONGED_MAX_UNITS_MEDICARE = 4; // §18.8: G0318 max 4

// ACP thresholds (§18.8 + §5.3)
const ACP_FIRST_MIN = 16;
const ACP_FIRST_MAX = 45;
const ACP_ADD_THRESHOLD = 46;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function suggestCodes(input: SuggestVisitInput): CptSuggestion {
  const acpMinutes = input.acpMinutes ?? 0;
  const base: CodeSuggestion[] = [];
  const prolonged: CodeSuggestion[] = [];
  const acp: CodeSuggestion[] = [];
  const modifiers: ModifierSuggestion[] = [];

  // Base code from time × visit type.
  const baseHit = pickBase(input);
  if (baseHit) {
    base.push(baseHit);
  }

  // Prolonged-service add-on (only when at/above the top-of-band threshold).
  const prolongedHit = pickProlonged(input);
  prolonged.push(...prolongedHit);

  // ACP add-ons stack on top of base — never replace it.
  const acpHits = pickAcp(acpMinutes);
  acp.push(...acpHits);

  // Telehealth modifier — added at the modifier level, not as a code.
  if (input.isTelehealth) {
    modifiers.push({
      modifier: "95",
      reason: "Telehealth modifier — synchronous audio + video. Switch to 93 for audio-only.",
    });
  }

  return {
    base,
    prolongedAddOns: prolonged,
    acpAddOns: acp,
    modifiers,
    inconclusive: base.length === 0 && acp.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function pickBase(input: SuggestVisitInput): CodeSuggestion | null {
  // ACP-only visits don't have a base E/M home visit code; the ACP
  // codes ARE the codes (vision §5.3, §18.8 row "Advance Care Planning").
  if (input.visitType === "advance_care_planning") return null;

  // Telehealth and inpatient_consult don't yet have a separate band
  // table here (they share the home-visit E/M codes per Mark's cheat
  // sheet, modified by the 95 modifier). Phase 4 will wire payer-
  // specific telehealth codes when the rule lookup confirms support.
  const bands =
    input.visitType === "new_patient_home"
      ? NEW_PATIENT_HOME_BANDS
      : input.visitType === "established_patient_home" ||
          input.visitType === "telehealth"
        ? ESTABLISHED_PATIENT_HOME_BANDS
        : null;

  if (!bands) return null;
  if (input.totalMinutes < 0) return null;

  const band = bands.find(
    (b) => input.totalMinutes >= b.minMinutes && input.totalMinutes <= b.maxMinutes,
  );
  if (!band) return null;

  // Edge case: within ±1 min of an upper band boundary, mark `edge`
  // so the clinician confirms before submission.
  const isEdge =
    band.maxMinutes !== Infinity &&
    Math.abs(input.totalMinutes - band.maxMinutes) <= 1;

  return {
    code: band.code,
    reason: edgeReasonText(input.visitType, input.totalMinutes, band),
    confidence: isEdge ? "edge" : "confirmed",
    attributedMinutes: input.totalMinutes,
  };
}

function edgeReasonText(
  visitType: VisitType,
  minutes: number,
  band: ThresholdBand,
): string {
  const label =
    visitType === "new_patient_home"
      ? "new patient home visit"
      : visitType === "telehealth"
        ? "telehealth visit (E/M home rates)"
        : "established patient home visit";
  const upperLabel = band.maxMinutes === Infinity ? "+" : `–${band.maxMinutes}`;
  return `${minutes} min in the ${band.minMinutes}${upperLabel} band for a ${label}.`;
}

function pickProlonged(input: SuggestVisitInput): CodeSuggestion[] {
  if (
    input.visitType !== "new_patient_home" &&
    input.visitType !== "established_patient_home" &&
    input.visitType !== "telehealth"
  ) {
    return [];
  }
  const topThreshold =
    input.visitType === "new_patient_home"
      ? NEW_PATIENT_TOP_THRESHOLD
      : ESTABLISHED_PATIENT_TOP_THRESHOLD;
  const overflow = input.totalMinutes - topThreshold;
  if (overflow <= 0) return [];

  // Each 15-minute block (or partial block) past the top threshold = 1 unit.
  // ceil() so a 14-min overflow rounds up to 1 unit (same as Mark's cheat
  // sheet — Medicare reimburses on initiated 15-min blocks).
  let units = Math.ceil(overflow / PROLONGED_INCREMENT_MINUTES);
  if (input.payerCategory === "medicare") {
    units = Math.min(units, PROLONGED_MAX_UNITS_MEDICARE);
  }

  if (units <= 0) return [];

  const code = input.payerCategory === "medicare" ? "G0318" : "99417";
  const note =
    input.payerCategory === "medicare"
      ? "Medicare prolonged-service add-on. Replaces 99417 in 2024+. Max 4 units per visit."
      : "Non-Medicare prolonged-service add-on (per 15 minutes past the visit cap).";

  return [
    {
      code,
      reason: `${units} unit(s). ${overflow} minutes past the ${topThreshold}-min cap. ${note}`,
      confidence: "confirmed",
      attributedMinutes: units * PROLONGED_INCREMENT_MINUTES,
    },
  ];
}

function pickAcp(acpMinutes: number): CodeSuggestion[] {
  if (acpMinutes < ACP_FIRST_MIN) return [];

  const first: CodeSuggestion = {
    code: "99497",
    reason: `${acpMinutes} ACP min — first 30 min code.`,
    confidence: acpMinutes <= ACP_FIRST_MIN + 1 ? "edge" : "confirmed",
    attributedMinutes: Math.min(acpMinutes, 45),
  };

  if (acpMinutes < ACP_ADD_THRESHOLD) {
    return [first];
  }

  const addOnUnits = Math.ceil((acpMinutes - 30) / 30);
  const second: CodeSuggestion = {
    code: "99498",
    reason: `${addOnUnits} additional 30-min unit(s). Must complete 99497 first.`,
    confidence: "confirmed",
    attributedMinutes: addOnUnits * 30,
  };
  return [first, second];
}
