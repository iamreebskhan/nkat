/**
 * Units per code (pure) — how many of each code a visit or a bill carries.
 *
 * visit.cpt_codes_assigned and superbill.cpt_codes are deduplicated SETS of
 * codes, and every reader that treats them as one (the rule sidebar, the
 * predictor, the 835 matcher, the documentation check) keeps doing so. The
 * count lives beside them in cpt_units (0106), a map keyed by code:
 *
 *   {"G0318": 3}   three units of G0318; every other code is one unit
 *   {}             every code is one unit — every row before 0106
 *
 * A claim line is one code and its units (CMS-1500 24D/24G, 837P SV104), with
 * the charge units × the per-unit rate (24F), so a count per code, not a
 * repeated code, is the shape the bill needs.
 *
 * Every write goes through normalizeUnits, so a key for a code that is no
 * longer on the claim is dropped rather than landing on the wrong code, and a
 * count of 1 is never stored. Used by the suggester, the visit and superbill
 * services, the PDF, the audit packet and the bill page.
 */

export type CodeUnits = Record<string, number>;

/**
 * The codes in this code set that CPT/HCPCS define per time increment, and so
 * the only ones that can bill more than one unit:
 *   - G0318 (HCPCS): Medicare prolonged home/residence E/M, per 15 minutes.
 *   - 99417 (CPT): prolonged outpatient/home E/M, per 15 minutes.
 *   - 99498 (CPT): each additional 30 minutes of advance care planning.
 * A home E/M (99341–99350) is reported once per date of service, and 99497 is
 * reported once (more time is 99498), so units on any other code are refused.
 */
export const PER_INCREMENT_CODES: ReadonlySet<string> = new Set(["G0318", "99417", "99498"]);

/**
 * Pallio's cap on G0318 units per visit — vision §18.8. It is Pallio's policy,
 * not a verified Medicare rule: the CMS practitioner MUE for G0318 has not been
 * checked (ncci_mue is empty and nothing reads it), so nothing here claims
 * Medicare allows this many and no more.
 */
export const G0318_MAX_UNITS = 4;

/** The most units one line can carry — the same bound as the 0106 CHECK and the API. */
export const MAX_UNITS_PER_LINE = 99;

/** A whole number of units the column accepts. */
function isUnitCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_UNITS_PER_LINE;
}

/** The units one code carries: a whole number from 1 to 99, else 1. */
export function unitsOf(u: CodeUnits | null | undefined, code: string): number {
  const n = u?.[code];
  return isUnitCount(n) ? n : 1;
}

/**
 * The canonical units map for these codes: only codes on the claim, only
 * per-increment codes, only whole counts from 2 to 99. A count of 1 is left
 * out, because a code with no key is one unit.
 */
export function normalizeUnits(codes: readonly string[], u: CodeUnits | null | undefined): CodeUnits {
  const out: CodeUnits = {};
  for (const code of new Set(codes)) {
    if (!PER_INCREMENT_CODES.has(code)) continue;
    const n = u?.[code];
    if (isUnitCount(n) && n > 1) out[code] = n;
  }
  return out;
}

/**
 * Why these units cannot be written: more than one unit on a code billed once
 * per visit, or a count that is not a whole number from 1 to 99. Refused (422)
 * rather than dropped, because a biller who typed 99350 × 2 meant to bill it
 * and must be told it will not be. The API's schema refuses a bad count first;
 * this is the services' own check, so a caller that skips the schema is told
 * too, rather than normalizeUnits quietly resetting G0318 × 150 to one unit.
 * The codes are taken for symmetry with the other helpers; such a key is
 * refused whether or not its code is on the claim, since no screen produces one.
 */
export function unitErrors(codes: readonly string[], u: CodeUnits | null | undefined): string[] {
  const out: string[] = [];
  for (const [code, n] of Object.entries(u ?? {})) {
    if (!isUnitCount(n)) {
      out.push(`${code} units must be a whole number from 1 to ${MAX_UNITS_PER_LINE}.`);
    } else if (n > 1 && !PER_INCREMENT_CODES.has(code)) {
      out.push(`${code} is billed once per visit; units apply only to G0318, 99417 and 99498.`);
    }
  }
  return out;
}

/** What to verify about these units before submitting: G0318 above Pallio's cap. */
export function unitWarnings(codes: readonly string[], u: CodeUnits | null | undefined): string[] {
  const g0318 = unitsOf(normalizeUnits(codes, u), "G0318");
  if (g0318 <= G0318_MAX_UNITS) return [];
  return [
    `G0318 is billed at ${g0318} units, above the ${G0318_MAX_UNITS} per visit Pallio allows (vision §18.8). Confirm the documented time and the CMS MUE before submitting.`,
  ];
}

/** The codes as a printed list, with the units beside any code that carries more than one: "99350, G0318 ×3". */
export function formatCodes(codes: readonly string[], u: CodeUnits | null | undefined): string {
  const units = normalizeUnits(codes, u);
  return [...new Set(codes)]
    .map((c) => (unitsOf(units, c) > 1 ? `${c} ×${unitsOf(units, c)}` : c))
    .join(", ");
}

/** Same codes, in any order and with any repeats, and the same units on each. */
export function sameAssignment(
  aCodes: readonly string[],
  aU: CodeUnits | null | undefined,
  bCodes: readonly string[],
  bU: CodeUnits | null | undefined,
): boolean {
  const a = [...new Set(aCodes)].sort();
  const b = [...new Set(bCodes)].sort();
  if (a.length !== b.length || a.some((c, i) => c !== b[i])) return false;
  const au = normalizeUnits(a, aU);
  const bu = normalizeUnits(b, bU);
  return a.every((c) => unitsOf(au, c) === unitsOf(bu, c));
}
