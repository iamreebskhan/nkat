/**
 * CMS Final Rule extractor.
 *
 * Two-stage:
 *   1. PDF → plaintext (pdf-parse).
 *   2. plaintext → extraction-queue candidates.
 *
 * Two extraction backends, picked at call-time:
 *   - `deterministic` — regex heuristics: find "CPT XXXXX" / "HCPCS XXXXX"
 *      mentions + the surrounding sentence; emits an analyst-review
 *      candidate with `coverage_status='varies'` and `confidence=0.20`.
 *      Always available, never crashes, gives the analyst a starting
 *      point for every code the rule mentions.
 *   - `bedrock` — when Bedrock is configured, send the extracted text
 *      to Claude with a strict JSON-shape prompt; promote confidence
 *      to whatever the model returns. The deterministic pass still
 *      runs first as a floor.
 *
 * Pure helpers below; the worker (`scripts/extract-final-rules.ts`)
 * does the I/O.
 */

export interface CodeMention {
  code: string;          // CPT/HCPCS code
  context: string;       // ~200-char sentence containing the code
  /** Approximate page (lines per page = 50, conservative). */
  page: number;
  /** Character offset in the document. */
  offset: number;
}

export interface CandidateProposal {
  code: string;
  source_quote: string;
  source_page: number;
  proposed_coverage_status: 'covered' | 'not_covered' | 'varies' | 'unknown';
  proposed_confidence: number;
  /** Free-text rationale for the analyst — never user-facing. */
  rationale: string;
  extractor_name: string;
}

const CPT_RE = /\b(\d{4}[A-Z\d]|\d{5})\b/g;
const HCPCS_LEVEL2_RE = /\b([A-Z]\d{4})\b/g;

// Negative-lookbehind so "cover" preceded by "not " falls under
// NEGATIVE only — the cue counters stay disjoint and the test
// "CMS will not cover 99213" classifies cleanly as not_covered
// instead of mixed-→-varies.
const POSITIVE_CUES = [
  /(?<!\bnot\s+)\bcover(ed|s|age|ing)?\b/i,
  /(?<!\bnot\s+)\bpaid\b/i,
  /\beligible\b/i,
  /\breimburs(e|ed|able|ement)\b/i,
];
const NEGATIVE_CUES = [
  /\bnot\s+cover(ed|s|age|ing)?\b/i,
  /\bwill\s+not\s+pay\b/i,
  /\bdenied?\b/i,
  /\bexclude(d|s)?\b/i,
  /\bnon-?covered\b/i,
  /\bineligible\b/i,
];

/**
 * Find every code mention with a one-sentence window around it.
 * Pure: same input → same output.
 */
export function findCodeMentions(text: string): CodeMention[] {
  const seen = new Set<string>();
  const out: CodeMention[] = [];
  for (const re of [CPT_RE, HCPCS_LEVEL2_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const code = m[1];
      if (!code) continue;
      // Skip single-occurrence dedupe via offset-aware key so we still
      // emit two separate mentions of the same code at different pages.
      const offset = m.index ?? 0;
      const key = `${code}:${Math.floor(offset / 1000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const context = sentenceAround(text, offset);
      // ~50 lines/page is a reasonable Final Rule density.
      const linesBeforeOffset = (text.slice(0, offset).match(/\n/g) ?? []).length;
      out.push({
        code,
        context,
        page: Math.max(1, Math.floor(linesBeforeOffset / 50) + 1),
        offset,
      });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

function sentenceAround(text: string, offset: number, half = 200): string {
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, offset + half);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Score the coverage stance of a context window using cue words.
 * Returns the stance + a confidence reflecting how strong the signal is.
 */
export function scoreCoverageStance(context: string): {
  status: CandidateProposal['proposed_coverage_status'];
  confidence: number;
  matched_cues: string[];
} {
  const positive = POSITIVE_CUES.filter((re) => re.test(context));
  const negative = NEGATIVE_CUES.filter((re) => re.test(context));

  if (negative.length > 0 && positive.length === 0) {
    return {
      status: 'not_covered',
      confidence: Math.min(0.45, 0.15 + 0.1 * negative.length),
      matched_cues: negative.map((r) => r.source),
    };
  }
  if (positive.length > 0 && negative.length === 0) {
    return {
      status: 'covered',
      confidence: Math.min(0.45, 0.15 + 0.1 * positive.length),
      matched_cues: positive.map((r) => r.source),
    };
  }
  if (positive.length > 0 && negative.length > 0) {
    return {
      status: 'varies',
      confidence: 0.20,
      matched_cues: [...positive.map((r) => r.source), ...negative.map((r) => r.source)],
    };
  }
  return { status: 'unknown', confidence: 0.10, matched_cues: [] };
}

/**
 * Propose a candidate per CodeMention. Pure.
 */
export function proposeCandidates(mentions: CodeMention[]): CandidateProposal[] {
  return mentions.map((m) => {
    const score = scoreCoverageStance(m.context);
    return {
      code: m.code,
      source_quote: m.context,
      source_page: m.page,
      proposed_coverage_status: score.status,
      proposed_confidence: score.confidence,
      rationale:
        score.matched_cues.length > 0
          ? `regex_v1 cues: ${score.matched_cues.join(', ')}`
          : 'regex_v1 no-cue mention — analyst review',
      extractor_name: 'regex_v1',
    };
  });
}

/**
 * Extract text from a PDF buffer using pdf-parse. The lib loads
 * lazily — the test suite doesn't pull pdfjs into memory unless this
 * code path runs.
 */
export async function extractPdfText(buf: Buffer): Promise<{ text: string; pageCount: number }> {
  // Dynamic import keeps test boot light + sidesteps pdf-parse's
  // CommonJS-default-export oddity at type level.
  const mod = (await import('pdf-parse')) as unknown as
    | ((b: Buffer) => Promise<{ text: string; numpages: number }>)
    | { default: (b: Buffer) => Promise<{ text: string; numpages: number }> };
  const fn = typeof mod === 'function' ? mod : mod.default;
  const r = await fn(buf);
  return { text: r.text, pageCount: r.numpages };
}
