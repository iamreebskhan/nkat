/**
 * Regex-based PHI redactor (v1).
 *
 * Detects + redacts the most common patient-identifier patterns in text
 * uploaded for reconciliation. Conservative by design: better to over-redact
 * a sample claim than leak a real MRN.
 *
 * Phase 3.5+ swaps the pure-regex pass for AWS Comprehend Medical or
 * Microsoft Presidio; the contract (input text → redacted text + category
 * counts) stays the same.
 */

export type PhiCategory =
  | 'ssn'
  | 'mrn'
  | 'member_id'
  | 'dob'
  | 'phone'
  | 'email'
  | 'icn'      // claim/encounter ID candidate
  | 'name_titled'
  | 'address'  // street address with house number + street type
  | 'zip'      // 5- or 9-digit ZIP, only when paired with city/state context
  | 'npi'      // 10-digit NPI when labelled
  | 'account'; // account-number labelled run

export interface RedactionResult {
  redacted: string;
  /** Counts per category — stored in audit. NEVER store the raw values. */
  category_counts: Record<PhiCategory, number>;
  total_redactions: number;
}

interface Pattern {
  category: PhiCategory;
  /** Regex must be /g flagged. */
  re: RegExp;
  /** Replacement template; `${cat}` is substituted at runtime. */
  replacement: (cat: PhiCategory, match: string) => string;
}

/**
 * SSN: 3-2-4 with optional dashes/spaces. Skip 000-XX-XXXX, 666-XX-XXXX,
 * 9XX-XX-XXXX (not assigned per SSA), and the well-known 123-45-6789 / 078-05-1120
 * test values. Word-boundary anchored.
 */
const SSN = /\b(?!000|666|9)([0-7]\d{2})[\s-]?(?!00)(\d{2})[\s-]?(?!0000)(\d{4})\b/g;

/** MRN: 6–10 digit run preceded by an MRN-ish label. */
const MRN_LABELED = /\b(?:mrn|medical record(?:\s+number)?|chart\s*#)[\s:#]*([A-Z0-9-]{4,16})\b/gi;

/**
 * Member ID: 6–15 alphanumeric run preceded by an explicit member-ish label.
 * `patient` alone is intentionally NOT a label here — it would collide with
 * `Patient: <Name>` and consume names. We require `patient id`.
 */
const MEMBER_LABELED = /\b(?:member(?:\s+id)?|subscriber(?:\s+id)?|patient\s+id)[\s:#]*([A-Z0-9-]{4,18})\b/gi;

/**
 * Dates of birth: explicit DOB labels OR clearly-DOB-shaped dates that match
 * common formats. We're aggressive — billers often write "DOB 4/12/1950" inline.
 */
const DOB_LABELED = /\b(?:dob|date\s+of\s+birth|d\.o\.b\.?|born)[\s:]*((?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})|(?:\d{4}-\d{2}-\d{2}))\b/gi;

/** US phone numbers — XXX-XXX-XXXX, (XXX) XXX-XXXX, +1-XXX-XXX-XXXX. */
const PHONE = /(?:\+1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/** Emails — keep this loose. */
const EMAIL = /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;

/**
 * Internal Control Number / claim ID candidate. We only flag when paired with
 * an "ICN" / "control number" label so we don't redact every 8-digit code.
 */
const ICN_LABELED = /\b(?:ICN|control\s+number|claim\s*#|claim\s+control)[\s:#]*([A-Z0-9-]{6,24})\b/gi;

/**
 * "Patient: <FirstName LastName>" style — high-signal when the literal label
 * is present, low false-positive risk because we require the label.
 */
const NAME_TITLED = /\b(?:patient(?:\s+name)?|name)[\s:]+([A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+)+)\b/gi;

/**
 * Street address — house number + street name + common street type.
 * Avoids matching mailing addresses without house numbers.
 */
const ADDRESS = /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Highway|Hwy|Parkway|Pkwy|Terrace|Ter)\b\.?/g;

/**
 * NPI: 10-digit National Provider Identifier, only when explicitly
 * labelled. (Bare 10-digit runs are too noisy to chase otherwise.)
 */
const NPI_LABELED = /\b(?:NPI|provider\s+(?:id|identifier))[\s:#]*(\d{10})\b/gi;

/**
 * Account number — labelled run, similar to ICN/MRN but for billing
 * account references.
 */
const ACCOUNT_LABELED = /\b(?:account(?:\s+number)?|acct(?:\s*#)?)[\s:#]*([A-Z0-9-]{4,20})\b/gi;

/**
 * ZIP — 5 or 9 digit (ZIP+4) form, only when in classic City, ST 12345
 * context. Plain 5-digit runs are too noisy.
 */
const ZIP_CONTEXTUAL = /,\s*[A-Z]{2}\s+(\d{5}(?:-\d{4})?)\b/g;

const DEFAULT_REPLACEMENT = (cat: PhiCategory): string => `[REDACTED:${cat.toUpperCase()}]`;

/**
 * Pattern application order matters. Labelled patterns (ICN, MRN, Member ID,
 * DOB, Name) must run BEFORE the unanchored ones (SSN, phone) — otherwise
 * the unlabelled phone regex eats a 10-digit run inside a labelled claim/ICN
 * number first and the labelled match never fires.
 *
 * Email goes after the labelled set but before phone/SSN (its anchor is `@`).
 * SSN runs last to claim only what remains.
 */
const PATTERNS: Pattern[] = [
  { category: 'icn',         re: ICN_LABELED,     replacement: (cat) => `ICN: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'mrn',         re: MRN_LABELED,     replacement: (cat) => `MRN: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'npi',         re: NPI_LABELED,     replacement: (cat) => `NPI: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'account',     re: ACCOUNT_LABELED, replacement: (cat) => `Account: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'member_id',   re: MEMBER_LABELED,  replacement: (cat) => `Member ID: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'dob',         re: DOB_LABELED,     replacement: (cat) => `DOB: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'name_titled', re: NAME_TITLED,     replacement: (cat) => `Patient: ${DEFAULT_REPLACEMENT(cat)}` },
  { category: 'address',     re: ADDRESS,         replacement: DEFAULT_REPLACEMENT },
  { category: 'zip',         re: ZIP_CONTEXTUAL,  replacement: (cat, m) =>
      // Preserve the leading ", ST " portion so the structural shape is intact.
      m.replace(/\d{5}(?:-\d{4})?/, DEFAULT_REPLACEMENT(cat)) },
  { category: 'email',       re: EMAIL,           replacement: DEFAULT_REPLACEMENT },
  { category: 'phone',       re: PHONE,           replacement: DEFAULT_REPLACEMENT },
  { category: 'ssn',         re: SSN,             replacement: DEFAULT_REPLACEMENT },
];

const ZERO_COUNTS = (): Record<PhiCategory, number> => ({
  ssn: 0, mrn: 0, member_id: 0, dob: 0, phone: 0, email: 0, icn: 0, name_titled: 0,
  address: 0, zip: 0, npi: 0, account: 0,
});

export const REDACTOR_NAME = 'regex_v2';
export const REDACTOR_VERSION = '2.0.0';

export function redactPhi(input: string): RedactionResult {
  let text = input;
  const counts = ZERO_COUNTS();
  for (const p of PATTERNS) {
    text = text.replace(p.re, (match) => {
      counts[p.category] += 1;
      return p.replacement(p.category, match);
    });
  }
  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
  return { redacted: text, category_counts: counts, total_redactions: total };
}
