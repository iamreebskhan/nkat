/**
 * Visit complexity on a claim: HCPCS G2211 until 31 December 2026, modifier B1
 * or B2 from 1 January 2027 (CY 2027 PFS final rule, CMS-1848-F).
 *
 * A bill carries its modifiers once, and every claim line used to get all of
 * them, which suits 95 or 93 on a telehealth claim. B1 and B2 go on the E/M
 * visit's own line only: "the modifier will be placed on the claim line for
 * the associated E/M code". On G0318 or 99497 they are a modifier the code
 * cannot take. B1 pays the visit at a higher rate, which the bill's price has
 * to follow, or a practice billing at Medicare's rate charges less than
 * Medicare would allow and is paid the charge.
 *
 * Pure: the bill, the claim file and the export all use it.
 */

/** The modifiers that replaced G2211, in the order a bill uses them: B2 over B1. */
export const VISIT_COMPLEXITY_MODIFIERS = ["B2", "B1"] as const;

/**
 * The E/M visits B1 and B2 may be appended to: CMS's "Mod B1 B2 Adjusted
 * RVUs" file for CY 2027, office/outpatient and home or residence visits.
 */
export const VISIT_COMPLEXITY_BASE_CODES: ReadonlySet<string> = new Set([
  "99202", "99203", "99204", "99205", "99211", "99212", "99213", "99214", "99215",
  "99341", "99342", "99344", "99345", "99347", "99348", "99349", "99350",
]);

/** The first day B1 and B2 exist, and the first day G2211 is not billed. */
export const VISIT_COMPLEXITY_MODIFIER_START = "2027-01-01";

const isComplexityModifier = (m: string) => (VISIT_COMPLEXITY_MODIFIERS as readonly string[]).includes(m.toUpperCase());

/** The bill's modifiers that go on one code's line: B1 and B2 on a visit code only. */
export function lineModifiers(code: string, modifiers: readonly string[]): string[] {
  return modifiers.filter((m) => !isComplexityModifier(m) || VISIT_COMPLEXITY_BASE_CODES.has(code));
}

/** Which complexity modifier prices a bill's visit line, if any: B2 over B1. */
export function complexityModifier(modifiers: readonly string[]): "B1" | "B2" | null {
  const upper = modifiers.map((m) => m.toUpperCase());
  return upper.includes("B2") ? "B2" : upper.includes("B1") ? "B1" : null;
}

/**
 * What a bill needs to hear about G2211, B1 and B2 on its date of service.
 * `dos` is the claim's day, 'YYYY-MM-DD'.
 */
export function visitComplexityWarnings(codes: readonly string[], modifiers: readonly string[], dos: string): string[] {
  const out: string[] = [];
  const from2027 = dos >= VISIT_COMPLEXITY_MODIFIER_START;
  const mods = modifiers.map((m) => m.toUpperCase());
  const hasB1 = mods.includes("B1");
  const hasB2 = mods.includes("B2");
  if (from2027 && codes.includes("G2211")) {
    out.push(
      "G2211 is not billed for a date of service from 1 January 2027: Medicare replaced it with modifier B1 on the visit's E/M code (B2 for a Shared Savings Program or LEAD ACO practitioner). Take G2211 off and add B1.",
    );
  }
  if (!from2027 && (hasB1 || hasB2)) {
    out.push(
      `Modifier ${hasB2 ? "B2" : "B1"} starts on 1 January 2027. For a visit before then, bill the complexity add-on as G2211 and take the modifier off.`,
    );
  }
  if ((hasB1 || hasB2) && !codes.some((c) => VISIT_COMPLEXITY_BASE_CODES.has(c))) {
    out.push(
      `Modifier ${hasB2 ? "B2" : "B1"} goes on an office or home visit code (99202–99215, 99341–99350), and this bill has none, so no line carries it.`,
    );
  }
  if (hasB1 && hasB2) {
    out.push("Bill B1 or B2, not both: B2 is for a practitioner in a Shared Savings Program or LEAD ACO, and pays in B1's place.");
  }
  return out;
}
