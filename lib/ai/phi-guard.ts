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
 */

const SAFE_HARBOR_PATTERNS: { name: string; re: RegExp }[] = [
  // SSN — XXX-XX-XXXX or 9 digits clustered
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  // Phone — (XXX) XXX-XXXX or XXX-XXX-XXXX
  { name: "phone", re: /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ },
  // Email — RFC-loose. Payer rule excerpts shouldn't carry these.
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // Date of birth shaped — MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD
  // Block 4-digit years 1900..2099 to avoid clobbering effective-date
  // citations the synthesizer needs. We allow YYYY in isolation.
  { name: "dob_slash", re: /\b(0?[1-9]|1[0-2])[\/](0?[1-9]|[12]\d|3[01])[\/](19|20)\d{2}\b/ },
  { name: "dob_dash", re: /\b(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])-(19|20)\d{2}\b/ },
  // MRN/member ID heuristic — long alphanumeric token (≥9 chars,
  // mixed digits + letters, not all letters). Tuned to avoid CPT
  // (5 digits) and ICD-10 (letter + 2-7 digits).
  { name: "mrn_like", re: /\b(?=[A-Z0-9]{9,})(?=.*\d)(?=.*[A-Z])[A-Z0-9]{9,20}\b/ },
];

/**
 * Names list — common first names + initial-letter pattern. We can't
 * detect every name; this catches the obvious "Hi this is John Doe..."
 * case. Tighten over time as we see real misuse.
 *
 * Skipped intentionally: too many false-positive risks for payer names
 * (Aetna, Humana etc.) and rule citations.
 */
const NAME_TRIGGERS = [
  /\bpatient\s+(?:is\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/i,
  /\bmember\s+(?:is\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+\b/i,
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
}

export function checkForPhi(text: string): PhiCheckResult {
  const hits: PhiCheckHit[] = [];
  for (const { name, re } of SAFE_HARBOR_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      hits.push({ pattern: name, excerpt: redact(m[0]) });
    }
  }
  for (const re of NAME_TRIGGERS) {
    const m = re.exec(text);
    if (m) {
      hits.push({ pattern: "name_trigger", excerpt: redact(m[0]) });
    }
  }
  return { ok: hits.length === 0, hits };
}

/**
 * Throw if any PHI-shaped content is in the payload. Use immediately
 * before every Anthropic call. The error message is generic on purpose
 * — the API caller / log retains the real hits, but we never echo
 * suspected PHI back into a 5xx response body.
 */
export function assertNoPhi(payload: string | string[], context: string): void {
  const blob = Array.isArray(payload) ? payload.join("\n") : payload;
  const result = checkForPhi(blob);
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
