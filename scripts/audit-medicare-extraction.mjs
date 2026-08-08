/**
 * Audit the CY2026 Medicare Final Rule extraction against the actual
 * source document.
 *
 * Two questions, both answered with numbers rather than assurances:
 *
 *   1. CORRECTNESS — does every stored source_quote actually appear,
 *      verbatim, in the Federal Register text? The seed claims this was
 *      verified at extraction time; nobody has re-checked it since, and
 *      the source it was verified against is long gone.
 *
 *   2. COMPLETENESS — how much rule-bearing content did the extraction
 *      capture? Measured by finding every CPT/HCPCS code the rule
 *      mentions and checking which ones produced a rule.
 */
import fs from 'node:fs';

// Directory holding final-rule.txt; override with MEDICARE_SRC.
const D = process.env.MEDICARE_SRC || '.';
const SEED = 'db/seed/payer-rules-cy2026-full-rule.sql';

// The Federal Register renders quotation marks as ``like this'' \u2014 both
// the source text and the stored quotes carry them, so normalise both to
// a plain double quote or nothing will ever match.
const norm = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/``/g, '"').replace(/'{2}/g, '"')
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2010-\u2015]/g, '-')
  .replace(/\s+/g, ' ')
  .trim().toLowerCase();

if (!fs.existsSync(`${D}/final-rule.txt`)) {
  console.error(`Source text not found at ${D}/final-rule.txt`);
  console.error('Download it first (4.6 MB), then re-run with MEDICARE_SRC pointing at it:');
  console.error('  curl -L -o final-rule.txt https://www.federalregister.gov/documents/full_text/text/2025/11/05/2025-19787.txt');
  process.exit(2);
}
const raw = fs.readFileSync(`${D}/final-rule.txt`, 'utf8');
const source = norm(raw);
console.log(`source: ${(raw.length / 1048576).toFixed(2)} MB, normalised to ${(source.length / 1048576).toFixed(2)} MB\n`);

// ---- 1. correctness: re-verify every stored quote ------------------
const seed = fs.readFileSync(SEED, 'utf8');
// Rows look like: (..., 'code', 'attribute', '{json}'::jsonb, 'status', 0.95, DATE '…', NULL, '…'::uuid, 'QUOTE', 'seed…')
// Pull the (code, attribute, quote) triples.
const rows = [];
const re = /\(\s*'([A-Z0-9]{5})'\s*,\s*'([a-z_]+)'/g;
let m;
const lines = seed.split(/\r?\n/);
for (const line of lines) {
  const codeAttr = line.match(/\('([A-Z0-9]{5})',\s*'([a-z_]+)'/);
  if (!codeAttr) continue;
  // Row shape: ('code', 'attribute', 'coverage_status', '{json}', 'quote')
  // The source_quote is the LAST single-quoted string on the line. Do NOT
  // collapse '' here — the Federal Register's ``…'' quote marks survive
  // into the stored text and norm() handles them.
  // SQL doubling must be undone BEFORE normalising quote marks: the
  // stored text reads ``2'''' , which unescapes to ``2'' , which is the
  // Federal Register's own closing quote and normalises to "2".
  const quoted = [...line.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
  const quote = quoted.length >= 2 ? quoted[quoted.length - 1] : null;
  if (quote && quote.length > 30) rows.push({ code: codeAttr[1], attribute: codeAttr[2], quote });
}

const seen = new Set();
const unique = rows.filter((r) => {
  const k = r.code + '|' + r.attribute;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

let grounded = 0;
const ungrounded = [];
for (const r of unique) {
  if (source.includes(norm(r.quote))) grounded++;
  else ungrounded.push(r);
}

console.log('=== 1. CORRECTNESS — are the stored quotes really in the source? ===');
console.log(`  distinct (code, attribute) rules in the seed : ${unique.length}`);
console.log(`  quotes found VERBATIM in the Federal Register: ${grounded}`);
console.log(`  NOT found                                    : ${ungrounded.length}`);
if (ungrounded.length) {
  console.log('\n  ungrounded examples:');
  for (const u of ungrounded.slice(0, 8)) {
    console.log(`    ${u.code}/${u.attribute}: "${u.quote.slice(0, 110)}…"`);
  }
}

// ---- 2. completeness: which codes does the rule discuss? -----------
// Every CPT (5 digits) and HCPCS (letter + 4 digits) token in the text.
const mentioned = new Map();
for (const tok of source.match(/\b(?:[a-z]\d{4}|\d{5})\b/g) ?? []) {
  const up = tok.toUpperCase();
  // 5-digit CPT range and HCPCS G/Q/J etc. Exclude obvious page/date noise.
  if (/^\d{5}$/.test(up) && !(+up >= 10000 && +up <= 99999)) continue;
  mentioned.set(up, (mentioned.get(up) ?? 0) + 1);
}
// A code discussed only once is usually a cross-reference or a page
// number collision; 3+ mentions means the rule is actually about it.
const substantive = [...mentioned.entries()].filter(([, n]) => n >= 3).map(([c]) => c);
const extracted = new Set(unique.map((r) => r.code));
const covered = substantive.filter((c) => extracted.has(c));
const missed = substantive.filter((c) => !extracted.has(c));

console.log('\n=== 2. COMPLETENESS — what fraction of discussed codes produced a rule? ===');
console.log(`  distinct code-like tokens in the rule        : ${mentioned.size}`);
console.log(`  discussed substantively (3+ mentions)        : ${substantive.length}`);
console.log(`  of those, extracted into a rule              : ${covered.length}  (${(covered.length / substantive.length * 100).toFixed(1)}%)`);
console.log(`  discussed but NOT extracted                  : ${missed.length}`);

// Which of the missed ones matter to a palliative practice?
const inScope = (c) => (/^\d{5}$/.test(c) && +c >= 99202 && +c <= 99499) || /^G0[1-4]\d{2}$/.test(c);
const missedInScope = missed.filter(inScope).sort();
console.log(`\n  of the missed, in the palliative E/M + G-code range: ${missedInScope.length}`);
if (missedInScope.length) console.log('    ' + missedInScope.join(' '));

const topMissed = missed.map((c) => [c, mentioned.get(c)]).sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('\n  most-discussed codes with NO rule extracted:');
for (const [c, n] of topMissed) console.log(`    ${c}  mentioned ${n}x${inScope(c) ? '   <-- IN SCOPE' : ''}`);

