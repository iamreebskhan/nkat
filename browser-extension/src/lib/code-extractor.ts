/**
 * code-extractor — pulls CPT/HCPCS codes out of a DOM tree.
 *
 * Strategy:
 *   1. Walk text nodes inside the body (ignoring SCRIPT/STYLE/NOSCRIPT).
 *   2. For each node, run a CPT/HCPCS regex.
 *   3. Filter out obvious false positives (years, ZIP codes, ICD-10s).
 *   4. Dedupe + return ordered by first appearance.
 *
 * Pure function: takes a Document, returns ExtractedCode[]. JSDOM-friendly.
 */

export interface ExtractedCode {
  code: string;
  /** Snippet of surrounding text (max 80 chars) for context. */
  context: string;
  code_system: 'CPT' | 'HCPCS2';
}

// CPT (5 digits, must start 0–9 but not 0): 10000–99999
const CPT_RE = /\b[1-9]\d{4}\b/g;
// HCPCS Level II: 1 letter + 4 digits (A0000–V9999, excluding S/W/Y/Z which are ad-hoc Medicaid).
const HCPCS_RE = /\b[A-V]\d{4}\b/g;
// ICD-10: letter, 2 digits, optional dot + up to 4 trailing chars.
const ICD10_RE = /\b[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/g;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function isLikelyYear(num: number): boolean {
  return num >= 19_000 && num <= 20_990 && num % 1 === 0;
}

function snippet(text: string, start: number, end: number, span = 30): string {
  const left = Math.max(0, start - span);
  const right = Math.min(text.length, end + span);
  const raw = text.slice(left, right).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
}

function collectFromText(text: string): ExtractedCode[] {
  const out: ExtractedCode[] = [];
  // ICD-10 spots first so we can exclude them from CPT/HCPCS hits inside the
  // same offset range.
  const icd10Spots: { start: number; end: number }[] = [];
  for (const m of text.matchAll(ICD10_RE)) {
    if (typeof m.index !== 'number') continue;
    icd10Spots.push({ start: m.index, end: m.index + m[0].length });
  }
  const overlapsIcd10 = (start: number, end: number): boolean =>
    icd10Spots.some((s) => !(end <= s.start || start >= s.end));

  for (const m of text.matchAll(CPT_RE)) {
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsIcd10(start, end)) continue;
    if (isLikelyYear(Number(m[0]))) continue;
    out.push({ code: m[0], code_system: 'CPT', context: snippet(text, start, end) });
  }
  for (const m of text.matchAll(HCPCS_RE)) {
    if (typeof m.index !== 'number') continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsIcd10(start, end)) continue;
    out.push({ code: m[0], code_system: 'HCPCS2', context: snippet(text, start, end) });
  }
  return out;
}

function shouldSkip(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}

export function extractCodes(root: ParentNode): ExtractedCode[] {
  const seen = new Set<string>();
  const out: ExtractedCode[] = [];
  // The walker traverses text nodes; manually skip subtrees of SKIP_TAGS.
  const stack: Node[] = [root as Node];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (shouldSkip(node)) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node as Text).nodeValue ?? '';
      if (!t.trim()) continue;
      for (const c of collectFromText(t)) {
        if (seen.has(c.code)) continue;
        seen.add(c.code);
        out.push(c);
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node !== root) continue;
    const children = (node as ParentNode).childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return out;
}

/** Visible for direct unit testing of the per-string scan. */
export const _testing = { collectFromText };
