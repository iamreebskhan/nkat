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
 * So: `mode: "document"` keeps every identifier that names a PERSON as a
 * hard block, and treats bare date shapes as a soft signal that only
 * refuses at record-set density — many DISTINCT dates in little text,
 * which is what a roster looks like and what prose does not. Soft signals
 * under that bar are reported as `warnings`, never dropped in silence.
 */

/** Which of the two kinds of payload is being scanned. See the note above. */
export type PhiScanMode = "prompt" | "document";

/**
 * Record-set bar for date shapes in document mode. A roster carries a
 * date per row, so distinct dates scale with its length; policy prose
 * cites the same handful of effective dates over and over, so its
 * DISTINCT count stays low no matter how long the document is. Both
 * conditions must hold, so neither a short dense revision-history table
 * nor a long lightly-dated manual can trip it on its own.
 */
const DOC_DATE_MIN_DISTINCT = 20;
const DOC_DATE_PER_10K = 15;

interface PhiPattern {
  name: string;
  re: RegExp;
  /** Density-gated in document mode; always a hard block in prompt mode. */
  soft?: boolean;
}

const SAFE_HARBOR_PATTERNS: PhiPattern[] = [
  // SSN — XXX-XX-XXXX or 9 digits clustered
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  // Phone — (XXX) XXX-XXXX or XXX-XXX-XXXX
  { name: "phone", re: /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ },
  // Email — RFC-loose. Payer rule excerpts shouldn't carry these.
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // Date of birth shaped — MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD
  // Block 4-digit years 1900..2099 to avoid clobbering effective-date
  // citations the synthesizer needs. We allow YYYY in isolation.
  //
  // Soft in document mode only — see the note at the top of the file. A
  // date accompanied by an actual identifier is still caught, because the
  // identifier itself is a hard pattern; and "DOB:"/"date of birth:" stay
  // hard through NAME_TRIGGERS, so a labelled birth date refuses in both
  // modes regardless of density.
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
  {
    name: "mrn_like",
    re: /\b(?=[A-Z0-9]{9,20}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{9,20}\b/,
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
 * These stay hard in BOTH modes. Each one names a person or explicitly
 * labels an identifier, so a single occurrence is evidence on its own —
 * unlike a bare date, which is evidence of nothing.
 */
const NAME_TRIGGERS = [
  // Human names are proper-cased. These two MUST stay case-SENSITIVE:
  // with /i they fired on ordinary billing phrasing like "patient
  // home visit" / "member group number" and refused legitimate
  // rule-lookup queries (caught by the gold-standard eval).
  // "patient is John Smith" / "member Jane Doe" still match.
  /\b[Pp]atient\s+(?:is\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/,
  /\b[Mm]ember\s+(?:is\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/,
  // Keyword markers — case-insensitive is correct here.
  /\bdob\s*[:=]/i,
  /\bdate\s+of\s+birth\s*[:=]/i,
  /\bsocial\s+security\s+number\s*[:=]/i,
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

  for (const p of SAFE_HARBOR_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const hit = { pattern: p.name, excerpt: redact(m[0]) };

    if (mode === "document" && p.soft) {
      const distinct = countDistinct(p.re, text);
      const per10k = (distinct / Math.max(text.length, 1)) * 10_000;
      if (distinct >= DOC_DATE_MIN_DISTINCT && per10k >= DOC_DATE_PER_10K) {
        hits.push(hit);
      } else {
        warnings.push({
          pattern: p.name,
          excerpt: `${hit.excerpt} ×${distinct} distinct (${per10k.toFixed(1)}/10k chars)`,
        });
      }
      continue;
    }

    hits.push(hit);
  }

  for (const re of NAME_TRIGGERS) {
    const m = re.exec(text);
    if (m) {
      hits.push({ pattern: "name_trigger", excerpt: redact(m[0]) });
    }
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
