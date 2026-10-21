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
 *   - The prolonged-service add-on is the one the payer takes: its record's
 *     own choice where it names one (0108), else G0318 for Medicare and
 *     99417 for everyone else. The orchestrator resolves it from the payer.
 *   - ACP minutes are tracked apart from the visit's total so 99497/99498
 *     stack on top of the base code, and the minutes they bill are taken out
 *     of the time both the base code and the prolonged-service add-on are
 *     chosen on, so no minute is billed both as ACP and as E/M time.
 *
 * Cheat-sheet: see § "5.3 CPT Code Intelligence" in the vision doc for
 * the canonical rate table — this file owns ONLY the boundary logic.
 */
import {
  G0318_MAX_UNITS,
  normalizeUnits,
  type CodeUnits,
} from "@/lib/features/billing/code-units";
import type { ProlongedServiceCode } from "@/lib/features/billing/prolonged-code";

/**
 * The coding band: which ladder the base E/M code comes from. Telehealth is
 * not one (audit R22) — it is how the visit happened, carried by
 * `isTelehealth` below, and it adds modifier 95/93 without moving the band.
 *
 * `non_billable` is the band for an encounter that is never billed (audit
 * R18): no base code, no add-on, no modifier.
 */
export type VisitType =
  | "new_patient_home"
  | "established_patient_home"
  | "advance_care_planning"
  | "inpatient_consult"
  | "non_billable";

export type PayerCategory = "medicare" | "non_medicare";

export interface SuggestVisitInput {
  visitType: VisitType;
  /**
   * Total documented visit minutes, start to stop. The document page sends the
   * whole visit, any ACP conversation held during it included (the audit
   * packet reads it back as "N minutes total, of which M minutes advance care
   * planning"). This said "excluding ACP", which the page never did, so the
   * ACP minutes were counted a second time as E/M time. The suggester now
   * takes the minutes billed as 99497/99498 out itself, from both the base
   * code's band and the prolonged-service add-on: CPT counts no time spent on
   * a separately reported service toward E/M time. Under 16 ACP minutes no
   * ACP code bills, so nothing comes out and that time stays E/M time.
   */
  totalMinutes: number;
  /** Minutes spent on advance-care-planning specifically. */
  acpMinutes?: number;
  /** Drives G0318 (Medicare) vs 99417 (non-Medicare) prolonged-service code. */
  payerCategory: PayerCategory;
  /**
   * The prolonged-service code this payer takes, where its payer record names
   * one (payer.prolonged_service_code, 0108). It wins over payerCategory: an
   * Ohio Medicaid managed-care plan that takes G0318 is not Medicare, and the
   * category alone offered its patients 99417 only. Absent, payerCategory
   * decides, as before.
   */
  prolongedServiceCode?: ProlongedServiceCode;
  /** Telehealth modality affects the modifier suggestion (vision §5.2). */
  isTelehealth?: boolean;
  /** "audio_video" → modifier 95; "audio_only" → modifier 93. */
  telehealthModality?: "audio_video" | "audio_only";
  /**
   * The time ladders, built from `code.typical_minutes` — never hardcoded here.
   *
   * This used to be two constant arrays in this file, and they had drifted from
   * every other statement of the same ladder in the product: the code
   * descriptors, the AI parser prompt and the gold-standard eval all say
   * 15/30/60/75 and 20/30/40/60, while these bands fired at 0/20/45/60 and
   * 0/25/35/60. Seven of eight codes fired early, every one of them toward the
   * higher-paying code. Passing the ladder in means there is one source and the
   * eval tests the same numbers the suggester uses.
   */
  bands: VisitCodeBands;
}

export type SuggestionConfidence = "edge" | "confirmed";

export interface CodeSuggestion {
  code: string;
  /** A short reason for the analyst — never user-facing copy alone. */
  reason: string;
  /** `edge` when at a boundary; ask clinician to confirm. */
  confidence: SuggestionConfidence;
  /**
   * How many of this code to bill. 1 for a base E/M and for 99497; the time
   * increments for G0318, 99417 and 99498. It used to exist only as the
   * "N unit(s)." at the start of `reason`, so every add-on was billed once.
   */
  units: number;
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
  /**
   * The visit's band is "Not billed" (audit R18): nothing is coded because
   * nothing is billed, which is a conclusion, not a gap for the clinician to fill.
   */
  nonBillable: boolean;
  /**
   * Why a home visit has no base code although its whole total would have
   * coded one: the minutes billed as ACP were taken out and the E/M time left
   * is short of the ladder's first code. Null otherwise. Without it an all-ACP
   * home visit shows 99497 alone and says nothing about the missing E/M code,
   * because 99497 makes the suggestion conclusive. Codes and minutes only.
   */
  baseNote: string | null;
  /**
   * More ACP minutes than the visit's whole time (acpOverTotalProblem's
   * sentence), so nothing is coded until they agree. Null otherwise.
   */
  acpOverTotal: string | null;
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

export interface VisitCodeBands {
  newPatientHome: ThresholdBand[];
  establishedPatientHome: ThresholdBand[];
}

/** One code and the time CPT states for it, as stored in `code`. */
export interface CodeTime {
  code: string;
  typicalMinutes: number;
}

/**
 * Turn a code's stated time into the band it governs.
 *
 * A code's stated time is the point from which it applies; the band runs from
 * there to one minute below the next code's time, and the last code is open
 * ended. So 15/30/60/75 gives 15–29, 30–59, 60–74, 75+.
 *
 * NOTE what this deliberately does NOT do: it does not start the first band at
 * zero. A visit shorter than the lowest stated time does not meet any code's
 * time, and the honest answer there is "no time-based code applies" — the
 * suggester returns inconclusive and the clinician chooses. The previous
 * hardcoded ladder started at 0, which meant a 3-minute visit was silently
 * suggested as a full home visit.
 */
export function buildBands(times: CodeTime[]): ThresholdBand[] {
  const sorted = [...times]
    .filter((t) => Number.isFinite(t.typicalMinutes) && t.typicalMinutes > 0)
    .sort((a, b) => a.typicalMinutes - b.typicalMinutes);

  return sorted.map((t, i) => ({
    minMinutes: t.typicalMinutes,
    maxMinutes: i === sorted.length - 1 ? Infinity : sorted[i + 1]!.typicalMinutes - 1,
    code: t.code,
  }));
}

/** The codes each ladder is built from, in ascending order. */
export const NEW_PATIENT_HOME_CODES = ["99341", "99342", "99344", "99345"] as const;
export const ESTABLISHED_PATIENT_HOME_CODES = ["99347", "99348", "99349", "99350"] as const;

/** Top-of-band threshold past which prolonged service applies. */
/**
 * The prolonged-service cap is the top band's own threshold — the point past
 * which extra time is billed as an add-on rather than a bigger base code.
 *
 * These were two more hardcoded constants, 75 and 60, and they were RIGHT:
 * they matched the code descriptors while the band table in this same file put
 * 99345 at 60. The file disagreed with itself, which is the clearest evidence
 * that the bands were the error. Deriving both from the ladder means they
 * cannot drift apart again.
 *
 * This is 99417's threshold (CPT). Medicare's G0318 starts later, at the CMS
 * total time below, which the ladder cannot supply.
 */
function topThresholdOf(bands: ThresholdBand[]): number | null {
  const top = bands[bands.length - 1];
  return top ? top.minMinutes : null;
}

const PROLONGED_INCREMENT_MINUTES = 15;

/**
 * Where G0318 starts: the RUC total time CMS values each top home E/M at, in
 * minutes. G0318 is reported per FULL 15 minutes past it, so the first unit is
 * at 140 minutes on 99345 and at 110 on 99350 (CMS CY2023 Physician Fee
 * Schedule final rule; AAFP FPM "Coding home visits"; CMS MLN006764).
 *
 * These are keyed by code, which this file otherwise refuses to do (see
 * `bands` above), because they cannot be derived from the ladder: they are
 * CMS's total times, not the CPT times in code.typical_minutes (99345 = 75,
 * 99350 = 60). G0318 used to start at those CPT times, which put a unit CMS
 * does not pay on every Medicare visit from 61 to 109 minutes. A top code with
 * no entry here is suggested no G0318 at all rather than a guessed threshold.
 */
const G0318_CMS_TOTAL_MINUTES: Readonly<Record<string, number>> = {
  "99345": 125,
  "99350": 95,
};

// ACP thresholds (§18.8 + §5.3). 99497 covers 16–45 minutes; each 99498 unit
// is 30 more past its 45, so 46–75 is one unit, 76–105 two, 106–135 three
// (CMS ACP FAQ; AAFP FPM "CMS ACP revisions").
const ACP_FIRST_MIN = 16;
const ACP_FIRST_MAX = 45;
const ACP_ADD_THRESHOLD = 46;
const ACP_ADD_INCREMENT_MINUTES = 30;

/**
 * The ACP minutes that bill as 99497/99498, and so are not E/M time: all of
 * them from 16 minutes, none below, where nothing bills as ACP and the time
 * stays E/M time. The bill page's time panel takes the same minutes out.
 */
export function acpBilledMinutes(acpMinutes: number): number {
  return acpMinutes >= ACP_FIRST_MIN ? acpMinutes : 0;
}

const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * ACP time is time spent during the visit, so more ACP minutes than the
 * visit's whole time is a record nothing supports. Nothing refused it: 40 ACP
 * minutes on a 30-minute visit were suggested 99497, and signed. The sentence
 * the document screen shows and signing refuses with; null when they agree.
 */
export function acpOverTotalProblem(
  acpMinutes: number | null | undefined,
  totalMinutes: number | null | undefined,
): string | null {
  const acp = acpMinutes ?? 0;
  const total = totalMinutes ?? 0;
  if (acp <= 0 || acp <= total) return null;
  return (
    `${minutesWord(acp)} of ACP is more than the visit's ${minutesWord(total)} in total. ` +
    `ACP time is part of the visit: correct the start and stop times, or the ACP minutes.`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function suggestCodes(input: SuggestVisitInput): CptSuggestion {
  // "Not billed" (audit R18) codes nothing at all, ACP minutes and the
  // telehealth modifier included. The ACP add-on in particular must not fire
  // on a bereavement visit: the patient it would plan for has died.
  if (input.visitType === "non_billable") {
    return {
      base: [],
      prolongedAddOns: [],
      acpAddOns: [],
      modifiers: [],
      inconclusive: false,
      nonBillable: true,
      baseNote: null,
      acpOverTotal: null,
    };
  }
  const acpMinutes = input.acpMinutes ?? 0;
  const base: CodeSuggestion[] = [];
  const prolonged: CodeSuggestion[] = [];
  const acp: CodeSuggestion[] = [];
  const modifiers: ModifierSuggestion[] = [];

  // Telehealth modifier — 95 for audio+video (default), 93 for audio-only.
  // Both follow CMS guidance + most commercial payer policies.
  if (input.isTelehealth) {
    const audioOnly = input.telehealthModality === "audio_only";
    modifiers.push({
      modifier: audioOnly ? "93" : "95",
      reason: audioOnly
        ? "Telehealth modifier — audio-only. Switch to 95 for synchronous audio + video."
        : "Telehealth modifier — synchronous audio + video. Switch to 93 for audio-only.",
    });
  }

  // More ACP minutes than the visit lasted: no code is supported until the
  // times or the ACP minutes are corrected. This used to stop E/M time at 0
  // and still suggest 99497/99498 on every ACP minute.
  const acpOverTotal = acpOverTotalProblem(acpMinutes, input.totalMinutes);
  if (acpOverTotal) {
    return {
      base,
      prolongedAddOns: prolonged,
      acpAddOns: acp,
      modifiers,
      inconclusive: true,
      nonBillable: false,
      baseNote: null,
      acpOverTotal,
    };
  }

  // ACP first: the minutes it bills are not E/M time. ACP add-ons stack on
  // top of the base code — never replace it.
  const acpHits = pickAcp(acpMinutes);
  // Under 16 ACP minutes nothing bills as ACP, so that time stays E/M time.
  const acpBilled = acpBilledMinutes(acpMinutes);
  const emMinutes = Math.max(0, input.totalMinutes - acpBilled);

  // Base code from E/M time × visit type.
  const baseHit = pickBase(input, emMinutes, acpBilled);
  if (baseHit) {
    base.push(baseHit);
  }

  // Prolonged-service add-on (only when at/above the top-of-band threshold),
  // counted on the same E/M time.
  const prolongedHit = pickProlonged(input, emMinutes, acpBilled);
  prolonged.push(...prolongedHit);

  acp.push(...acpHits);

  return {
    base,
    prolongedAddOns: prolonged,
    acpAddOns: acp,
    modifiers,
    inconclusive: base.length === 0 && acp.length === 0,
    nonBillable: false,
    baseNote: baseHit ? null : baseNoteFor(input, emMinutes, acpBilled),
    acpOverTotal: null,
  };
}

/**
 * What saving this suggestion assigns to the visit: the codes, base then
 * prolonged then ACP, and the units of any that carry more than one. The
 * document page saves exactly this, so the count the suggester made is the
 * count the bill prices.
 */
export function assignmentFromSuggestion(s: CptSuggestion): { codes: string[]; units: CodeUnits } {
  const all = [...s.base, ...s.prolongedAddOns, ...s.acpAddOns];
  const codes = all.map((c) => c.code);
  return {
    codes,
    units: normalizeUnits(codes, Object.fromEntries(all.map((c) => [c.code, c.units]))),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The base code, chosen on `emMinutes`: the visit's total less
 * `acpBilledMinutes`, the minutes billed as 99497/99498. CPT counts no time
 * spent on a separately reported service toward E/M time, so a 50-minute visit
 * with 20 minutes of ACP is 30 E/M minutes, 99348 — this chose on the whole 50
 * and suggested 99349.
 */
function pickBase(
  input: SuggestVisitInput,
  emMinutes: number,
  acpBilledMinutes: number,
): CodeSuggestion | null {
  // ACP-only visits don't have a base E/M home visit code; the ACP
  // codes ARE the codes (vision §5.3, §18.8 row "Advance Care Planning").
  if (input.visitType === "advance_care_planning") return null;

  // inpatient_consult has no band table here yet, so it codes nothing and
  // the clinician picks. Telehealth used to be a band of its own that shared
  // the established ladder, which put every new patient seen over video on
  // the wrong ladder (audit R22). The band now comes only from new vs
  // established; telehealth adds its 95/93 modifier on top.
  const bands = homeLadderOf(input);

  if (!bands || bands.length === 0) return null;
  if (input.totalMinutes < 0) return null;

  // The top band is open-ended. buildBands marks it with Infinity, but the
  // bands reach the document page as JSON from /api/billing/code-bands, and
  // JSON turns Infinity into null: `65 <= null` is false, so every visit at or
  // past the top threshold (60+ min established, 75+ new) got no base code
  // while its prolonged add-on still fired. Any non-finite bound is open.
  const band = bands.find(
    (b) => emMinutes >= b.minMinutes && emMinutes <= upperOf(b),
  );
  if (!band) return null;

  // Edge case: within ±1 min of an upper band boundary, mark `edge`
  // so the clinician confirms before submission.
  const isEdge =
    Number.isFinite(band.maxMinutes) &&
    Math.abs(emMinutes - band.maxMinutes) <= 1;

  return {
    code: band.code,
    reason:
      edgeReasonText(input.visitType, emMinutes, band) +
      acpTakenOut(emMinutes, input.totalMinutes, acpBilledMinutes),
    confidence: isEdge ? "edge" : "confirmed",
    // A home E/M is reported once per date of service, whatever the time.
    units: 1,
    attributedMinutes: emMinutes,
  };
}

/** The home-visit ladder the visit's band codes on; null for any other band. */
function homeLadderOf(input: SuggestVisitInput): ThresholdBand[] | null {
  return input.visitType === "new_patient_home"
    ? input.bands.newPatientHome
    : input.visitType === "established_patient_home"
      ? input.bands.establishedPatientHome
      : null;
}

/**
 * Said on each E/M row counted on less than the whole total, or the time on the
 * row reads as short of the time on screen. Empty when no ACP code bills.
 */
function acpTakenOut(emMinutes: number, totalMinutes: number, acpBilledMinutes: number): string {
  return acpBilledMinutes > 0
    ? ` Counted on ${emMinutes} of the ${totalMinutes} minutes; the ${acpBilledMinutes} ACP minutes bill as 99497/99498.`
    : "";
}

/**
 * Why a home visit has no base code, when taking the ACP-billed minutes out is
 * what cost it one: the whole total would have reached the ladder's first
 * code, the E/M time left does not. Null in every other case — a visit too
 * short to code either way, a band with no home ladder, no ACP billed.
 */
function baseNoteFor(
  input: SuggestVisitInput,
  emMinutes: number,
  acpBilledMinutes: number,
): string | null {
  if (acpBilledMinutes <= 0) return null;
  const first = homeLadderOf(input)?.[0];
  if (!first || input.totalMinutes < first.minMinutes) return null;
  return (
    `No home-visit E/M code on time: with the ${acpBilledMinutes} ACP minutes billed as 99497/99498 taken out, ` +
    `${emMinutes} of the ${input.totalMinutes} minutes are E/M time, short of the ${first.minMinutes} minutes ${first.code} needs.`
  );
}

/** A band's upper bound: the open top band may arrive as null over JSON. */
function upperOf(band: ThresholdBand): number {
  return Number.isFinite(band.maxMinutes) ? band.maxMinutes : Infinity;
}

function edgeReasonText(
  visitType: VisitType,
  minutes: number,
  band: ThresholdBand,
): string {
  const label =
    visitType === "new_patient_home"
      ? "new patient home visit"
      : "established patient home visit";
  const upperLabel = Number.isFinite(band.maxMinutes) ? `–${band.maxMinutes}` : "+";
  const article = visitType === "new_patient_home" ? "a" : "an";
  return `${minutes} min in the ${band.minMinutes}${upperLabel} band for ${article} ${label}.`;
}

/**
 * The prolonged-service add-on, counted on E/M time only — `emMinutes`, the
 * same time the base code is chosen on: the visit's total less
 * `acpBilledMinutes`, the minutes billed as 99497/99498. Counting the ACP
 * minutes here as well could add an add-on the E/M time did not reach, and
 * once units were priced it multiplied one that did — a 170-minute Medicare
 * visit with 60 ACP minutes billed G0318 × 4 where its 110 E/M minutes support
 * one.
 */
function pickProlonged(
  input: SuggestVisitInput,
  emMinutes: number,
  acpBilledMinutes: number,
): CodeSuggestion[] {
  const bands = homeLadderOf(input);
  if (!bands) return [];
  // The payer's own choice, else the payer category's.
  const byPayer = input.prolongedServiceCode !== undefined;
  const code = input.prolongedServiceCode ?? (input.payerCategory === "medicare" ? "G0318" : "99417");
  const hits = code === "G0318" ? pickG0318(bands, emMinutes, byPayer) : pick99417(bands, emMinutes, byPayer);
  // Say so when ACP minutes were taken out, or the count reads as short of the
  // time on screen.
  const note = acpTakenOut(emMinutes, input.totalMinutes, acpBilledMinutes);
  return note ? hits.map((h) => ({ ...h, reason: `${h.reason}${note}` })) : hits;
}

/**
 * CPT 99417: one unit per FULL 15 minutes past the top code's CPT time, so the
 * first unit is at 75 minutes on 99350 (60) and at 90 on 99345 (75). CPT does
 * not report it for less than 15 minutes. This used to round a part-block up,
 * which put a unit on every commercial visit from 61 to 74 minutes. No cap:
 * non-Medicare payers set their own.
 */
function pick99417(bands: ThresholdBand[], totalMinutes: number, byPayer: boolean): CodeSuggestion[] {
  const topThreshold = topThresholdOf(bands);
  if (topThreshold === null) return [];
  const overflow = totalMinutes - topThreshold;
  const units = Math.floor(overflow / PROLONGED_INCREMENT_MINUTES);
  if (units <= 0) return [];
  return [
    {
      code: "99417",
      reason:
        `${units} unit(s). ${overflow} minutes past the ${topThreshold}-min cap. ` +
        (byPayer
          ? "The prolonged-service add-on this payer takes (per full 15 minutes past the visit cap)."
          : "Non-Medicare prolonged-service add-on (per full 15 minutes past the visit cap)."),
      confidence: "confirmed",
      units,
      attributedMinutes: units * PROLONGED_INCREMENT_MINUTES,
    },
  ];
}

/**
 * HCPCS G0318 (CMS, CY2023 on): one unit per FULL 15 minutes past the CMS
 * total time for the top code — see G0318_CMS_TOTAL_MINUTES — capped at
 * G0318_MAX_UNITS, Pallio's own cap (vision §18.8). CMS counts time from 3
 * days before to 7 days after the visit; this sees only the visit's own
 * minutes, so it can under-count but never over-count.
 */
function pickG0318(bands: ThresholdBand[], totalMinutes: number, byPayer: boolean): CodeSuggestion[] {
  const topCode = bands[bands.length - 1]?.code;
  const cmsTotal = topCode ? G0318_CMS_TOTAL_MINUTES[topCode] : undefined;
  if (cmsTotal === undefined) return [];
  const past = totalMinutes - cmsTotal;
  const units = Math.min(Math.floor(past / PROLONGED_INCREMENT_MINUTES), G0318_MAX_UNITS);
  if (units <= 0) return [];
  return [
    {
      code: "G0318",
      reason:
        `${units} unit(s). ${past} minutes past the ${cmsTotal}-minute CMS total for ${topCode} ` +
        `(G0318 starts at ${cmsTotal + PROLONGED_INCREMENT_MINUTES}). ` +
        (byPayer ? "The prolonged home-visit add-on this payer takes" : "Medicare prolonged home-visit add-on") +
        `, per full 15 minutes; Pallio suggests at most ${G0318_MAX_UNITS} per visit.`,
      confidence: "confirmed",
      units,
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
    // Reported once; more time is 99498.
    units: 1,
    attributedMinutes: Math.min(acpMinutes, ACP_FIRST_MAX),
  };

  if (acpMinutes < ACP_ADD_THRESHOLD) {
    return [first];
  }

  // One unit from 46 minutes and one more every 30 after, counted from
  // 99497's 45: 46–75 ×1, 76–105 ×2. This counted from 30, which billed
  // 61–75 ACP minutes as two units where CMS pays one.
  const addOnUnits = Math.ceil((acpMinutes - ACP_FIRST_MAX) / ACP_ADD_INCREMENT_MINUTES);
  const second: CodeSuggestion = {
    code: "99498",
    reason: `${addOnUnits} additional 30-min unit(s). Must complete 99497 first.`,
    confidence: "confirmed",
    units: addOnUnits,
    attributedMinutes: addOnUnits * ACP_ADD_INCREMENT_MINUTES,
  };
  return [first, second];
}
