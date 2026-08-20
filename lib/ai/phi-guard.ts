/**
 * PHI guard — pre-send assertion that nothing PHI-shaped is about to
 * leave the platform via the Anthropic API.
 *
 * Source: pallio_complete_vision_v3 §15.4 ("no PHI to AI"). HIPAA
 * Privacy Rule 45 CFR §164.514(b) safe-harbor identifiers. We don't
 * have a BAA with Anthropic — every Claude call must be PHI-free.
 *
 * This is a defense-in-depth check. The primary defense is the
 * call-site contract: only structured fields (payer, state, CPT,
 * attribute) get passed in. This guard catches mistakes — a developer
 * who accidentally interpolates a patient name into a prompt, a payer
 * rule excerpt that contains a member ID, etc.
 *
 * On match: throw — never silently scrub. A throw becomes a 500 in
 * the API route, which is the right failure mode (loud + audited)
 * for what is fundamentally a HIPAA breach near-miss.
 *
 * ## Two things get scanned, and they are not alike
 *
 * Almost every call site passes a SHORT PROMPT WE COMPOSED from our own
 * data — a lookup query, a synthesis context, a denial summary. There,
 * anything PHI-shaped is by definition a mistake on our side, and the
 * strictest possible reading is correct.
 *
 * Document ingestion passes something categorically different: the full
 * text of a THIRD-PARTY PUBLIC DOCUMENT fetched from a payer's website.
 * That text never touched our database, so it cannot carry our patients'
 * PHI. The threat it guards against is narrower — a platform admin
 * registering an ingestion source that points at something it shouldn't,
 * e.g. a shared-drive roster. Against that threat a lone MM/DD/YYYY is
 * not evidence of anything: payer policies are made of dates (revised,
 * effective, superseded), and refusing on the first one means a whole
 * class of legitimate source can never be read.
 *
 * That is not hypothetical. It is why the Aetna clinical policy bulletin
 * sat at "no rules" — the guard refused on `dob_slash` + `mrn_like`, both
 * false positives, and the refusal looked identical to a real one.
 *
 * ## What a payer document actually contains
 *
 * The first cut of document mode kept every identifier that names a person
 * as a hard block and gated only bare dates. Then PDFs came into scope and
 * six real payer documents were measured against it. Five were refused:
 *
 *   provider manual   36 distinct phone numbers   800-600-9007, 855-819-5909
 *                      8 distinct emails          ac_edi_ops@uhc.com
 *                      5 mrn_like tokens          14A000000001 (a SAMPLE claim)
 *   prolonged svcs    1 mrn_like token            2025R0003A (the POLICY number)
 *   hospice policy    "Patient Self Determination", "Patient Monthly Liability"
 *   telehealth guide  medicaid@medicaid.ohio.gov, "Patient Site Definition"
 *
 * None of that is PHI. A payer document is full of contact details for
 * ORGANISATIONS, reference numbers for POLICIES, and headings that begin
 * with the word "Patient". Treating each shape as evidence on its own would
 * have blocked ingestion for essentially every source in the library.
 *
 * What distinguishes a patient roster is not the presence of those shapes
 * but their DENSITY and repetition: one identifier per row, so the distinct
 * count scales with the length of the file. Measured across those six
 * documents the densest single family was 9.2 distinct per 10k characters
 * (an Anthem policy citing 37 revision dates). A roster runs 70–200. There
 * is an order of magnitude between them, and the bar sits in the gap.
 *
 * So `mode: "document"` refuses on:
 *   - an SSN, at any density. No payer document prints one.
 *   - a LABELLED birth date ("DOB:", "date of birth:"). Zero occurrences
 *     across 580 KB of real payer text, and it is the marker that survives
 *     when a document holds only ONE patient — the case density cannot see.
 *   - anything else only at record-set density.
 *
 * Soft signals under the bar are reported as `warnings`, never dropped in
 * silence.
 *
 * Known and accepted: a single-patient document carrying no SSN and no DOB
 * label passes. Density cannot see one record, and the shapes that would
 * catch it are the same ones a provider manual is built from.
 */

/** Which of the two kinds of payload is being scanned. See the note above. */
export type PhiScanMode = "prompt" | "document";

/**
 * The record-set bar in document mode. A roster carries an identifier per
 * row, so its DISTINCT count scales with its length; a payer document names
 * the same few phone numbers, mailboxes and effective dates over and over,
 * so its distinct count stays flat however long it runs.
 *
 * 25 per 10k sits between the densest real payer document measured (9.2) and
 * the thinnest realistic roster (~70). Both conditions must hold, so neither
 * a short dense revision-history table nor a long manual full of department
 * phone numbers can trip it alone.
 */
const DOC_RECORD_MIN_DISTINCT = 20;
const DOC_RECORD_PER_10K = 25;

interface PhiPattern {
  name: string;
  re: RegExp;
  /** Density-gated in document mode; always a hard block in prompt mode. */
  soft?: boolean;
}

const SAFE_HARBOR_PATTERNS: PhiPattern[] = [
  // SSN — XXX-XX-XXXX or 9 digits clustered.
  // The one shape that stays hard in document mode: no payer policy,
  // manual or fee schedule has a reason to print a social security number.
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  // Phone — (XXX) XXX-XXXX or XXX-XXX-XXXX.
  // Soft in document mode: a provider manual lists dozens of them, and they
  // belong to the payer's own departments. 36 distinct in one UHC manual.
  { name: "phone", re: /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/, soft: true },
  // Email — RFC-loose. Payer rule excerpts shouldn't carry these.
  // Soft in document mode for the same reason: medicaid@medicaid.ohio.gov
  // is a department mailbox printed in the billing guidelines.
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    soft: true,
  },
  // Date of birth shaped — MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD
  // Block 4-digit years 1900..2099 to avoid clobbering effective-date
  // citations the synthesizer needs. We allow YYYY in isolation.
  //
  // Soft in document mode only — see the note at the top of the file.
  // "DOB:"/"date of birth:" stay hard through HARD_LABEL_TRIGGERS, so a
  // LABELLED birth date refuses in both modes regardless of density.
  {
    name: "dob_slash",
    re: /\b(0?[1-9]|1[0-2])[\/](0?[1-9]|[12]\d|3[01])[\/](19|20)\d{2}\b/,
    soft: true,
  },
  {
    name: "dob_dash",
    re: /\b(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])-(19|20)\d{2}\b/,
    soft: true,
  },
  // MRN/member ID heuristic — long alphanumeric token (≥9 chars,
  // mixed digits + letters, not all letters). Tuned to avoid CPT
  // (5 digits) and ICD-10 (letter + 2-7 digits).
  //
  // The lookaheads MUST be anchored to the token ([A-Z0-9]*), not left
  // open (.*). Unanchored they scan PAST the token to the end of the
  // line, so "mixed digits and letters" was satisfied by any digit
  // occurring later in the same sentence — which made this pattern mean
  // "any ALL-CAPS word of 9+ letters", and refused on TELEHEALTH,
  // AUTHORIZATION, REIMBURSEMENT. Anchored, it means what the paragraph
  // above always claimed it meant. Nothing that was caught before is
  // lost: a real member ID mixes digits INTO the token.
  //
  // Soft in document mode: even anchored, the shape of a member ID is the
  // shape of a policy number (2025R0003A) and of the sample member IDs a
  // manual prints to show you how to fill in a claim (14A000000001).
  {
    name: "mrn_like",
    re: /\b(?=[A-Z0-9]{9,20}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{9,20}\b/,
    soft: true,
  },
];

/**
 * Names list — common first names + initial-letter pattern. We can't
 * detect every name; this catches the obvious "Hi this is John Doe..."
 * case. Tighten over time as we see real misuse.
 *
 * Skipped intentionally: too many false-positive risks for payer names
 * (Aetna, Humana etc.) and rule citations.
 *
 * Split in two because the two halves behave differently on a real
 * document. An explicit LABEL is written by someone recording a person's
 * details and appears nowhere in policy prose — zero occurrences across
 * 580 KB of measured payer text — so it stays hard in both modes, and it is
 * what catches a document holding a single patient, which density cannot.
 *
 * The proper-cased name shapes are not that. In payer documents they match
 * section headings: "Patient Self Determination", "Patient Monthly
 * Liability", "Patient Site Definition", "Patient Contact". Fourteen such
 * matches across six documents, none of them a name. They stay hard in
 * prompt mode, where a prompt has no headings, and are density-gated in
 * document mode like every other shape.
 */
const HARD_LABEL_TRIGGERS = [
  // Keyword markers — case-insensitive is correct here.
  /\bdob\s*[:=]/i,
  /\bdate\s+of\s+birth\s*[:=]/i,
  /\bsocial\s+security\s+number\s*[:=]/i,
];

const NAME_SHAPE_TRIGGERS = [
  // Human names are proper-cased. These two MUST stay case-SENSITIVE:
  // with /i they fired on ordinary billing phrasing like "patient
  // home visit" / "member group number" and refused legitimate
  // rule-lookup queries (caught by the gold-standard eval).
  // "patient is John Smith" / "member Jane Doe" still match.
  /\b[Pp]atient\s+(?:is\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/,
  /\b[Mm]ember\s+(?:is\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/,
];

export interface PhiCheckHit {
  pattern: string;
  excerpt: string;
}

export interface PhiCheckResult {
  ok: boolean;
  hits: PhiCheckHit[];
  /**
   * Soft signals that were seen but did not reach the record-set bar.
   * Always empty in prompt mode, where nothing is soft. Present so a
   * near-miss is visible to the operator instead of being dropped —
   * "allowed" and "never noticed" must not look the same.
   */
  warnings: PhiCheckHit[];
}

export function checkForPhi(
  text: string,
  mode: PhiScanMode = "prompt",
): PhiCheckResult {
  const hits: PhiCheckHit[] = [];
  const warnings: PhiCheckHit[] = [];

  const record = (name: string, m: RegExpExecArray, re: RegExp, soft: boolean) => {
    const hit = { pattern: name, excerpt: redact(m[0]) };
    if (mode !== "document" || !soft) {
      hits.push(hit);
      return;
    }
    const distinct = countDistinct(re, text);
    const per10k = (distinct / Math.max(text.length, 1)) * 10_000;
    if (distinct >= DOC_RECORD_MIN_DISTINCT && per10k >= DOC_RECORD_PER_10K) {
      hits.push(hit);
    } else {
      warnings.push({
        pattern: name,
        excerpt: `${hit.excerpt} ×${distinct} distinct (${per10k.toFixed(1)}/10k chars)`,
      });
    }
  };

  for (const p of SAFE_HARBOR_PATTERNS) {
    const m = p.re.exec(text);
    if (m) record(p.name, m, p.re, !!p.soft);
  }

  for (const re of HARD_LABEL_TRIGGERS) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: "name_trigger", excerpt: redact(m[0]) });
  }

  for (const re of NAME_SHAPE_TRIGGERS) {
    const m = re.exec(text);
    if (m) record("name_trigger", m, re, true);
  }

  return { ok: hits.length === 0, hits, warnings };
}

function countDistinct(re: RegExp, text: string): number {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const seen = new Set<string>();
  for (const m of text.matchAll(global)) seen.add(m[0]);
  return seen.size;
}

/**
 * Throw if any PHI-shaped content is in the payload. Use immediately
 * before every Anthropic call. The error message is generic on purpose
 * — the API caller / log retains the real hits, but we never echo
 * suspected PHI back into a 5xx response body.
 *
 * `mode` defaults to the strict prompt reading. Pass "document" ONLY for
 * the text of a third-party document we fetched from a public URL.
 */
export function assertNoPhi(
  payload: string | string[],
  context: string,
  mode: PhiScanMode = "prompt",
): void {
  const blob = Array.isArray(payload) ? payload.join("\n") : payload;
  const result = checkForPhi(blob, mode);
  if (result.warnings.length > 0) {
    // Redacted excerpts only — same rule as the thrown message.
    console.warn(
      `PHI guard: soft signals below the record-set bar at ${context}: ` +
        result.warnings.map((w) => `${w.pattern} ${w.excerpt}`).join("; "),
    );
  }
  if (!result.ok) {
    // Caller catches → audit logs the hit list separately. Don't
    // include the excerpts in the thrown message; a thrown error
    // can flow through observability tools we don't fully control.
    throw new PhiGuardError(context, result.hits);
  }
}

export class PhiGuardError extends Error {
  readonly hits: PhiCheckHit[];
  readonly context: string;
  constructor(context: string, hits: PhiCheckHit[]) {
    super(
      `PHI guard tripped at ${context}: ${hits.map((h) => h.pattern).join(", ")}. ` +
        `Anthropic is not BAA-covered; the call was refused. Review the prompt.`,
    );
    this.name = "PhiGuardError";
    this.hits = hits;
    this.context = context;
  }
}

function redact(s: string): string {
  if (s.length <= 4) return "*".repeat(s.length);
  return s[0] + "*".repeat(Math.max(2, s.length - 2)) + s[s.length - 1];
}
