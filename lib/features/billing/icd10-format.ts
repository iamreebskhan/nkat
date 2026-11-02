/**
 * The shape of an ICD-10-CM code, for codes a clinician types rather than
 * picks.
 *
 * Both diagnosis pickers accept a code the search did not return — a code
 * from a release newer than the one loaded, or a correction the payer asked
 * for — and both stored it as typed. The bill page's picker took anything
 * starting with a letter and a digit and kept "I509" undotted, which then
 * matched nothing the search returns ("I50.9") and printed on the claim as
 * typed. This puts the code in the dotted form the reference table and every
 * payer use, or refuses it.
 */

/**
 * A letter, then a digit (or "QA", the FY2027 genetic-disorder categories),
 * then one more character: the three-character category. Up to four more
 * characters after it.
 */
const BARE = /^(?:[A-Z][0-9]|QA)[0-9A-Z]([0-9A-Z]{1,4})?$/;

/**
 * "i509", "I50.9", " i50.9 " → "I50.9"; "R64" → "R64". Null when the text is
 * not shaped like an ICD-10-CM code, so the caller can say so instead of
 * storing it.
 */
export function normalizeIcd10(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9.]+$/.test(s) || (s.match(/\./g) ?? []).length > 1) return null;
  // A dot is only ever after the category.
  if (s.includes(".") && s.indexOf(".") !== 3) return null;
  const bare = s.replace(".", "");
  if (!BARE.test(bare)) return null;
  return bare.length > 3 ? `${bare.slice(0, 3)}.${bare.slice(3)}` : bare;
}
