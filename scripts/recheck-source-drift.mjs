/**
 * ============================================================================
 * recheck-source-drift.mjs — re-fetch every cited document and check that it
 * STILL SAYS what the rules citing it claim.
 *
 * WHY
 * Every rule in this library carries a verbatim quote, and that quote is
 * checked once — at extraction. Nothing has ever re-checked it. Payers
 * renumber, rewrite and retire documents continuously, and when they do, the
 * rule keeps answering with a citation that no longer supports it.
 *
 * That is not hypothetical. Production has been citing
 *   https://www.aetna.com/cpb/medical/data/1_99/0009.html
 * which today serves "Orthopedic Casts, Braces and Splints" — Aetna
 * renumbered the bulletin out from under us. A biller clicking through for
 * their evidence lands on orthopedics. No existing check could see it: the
 * rule is live, sourced, internally consistent, and its quote is still
 * verbatim against the COPY WE STORED. Only re-reading the live document
 * finds it.
 *
 * WHAT IT WILL NOT DO
 * It never expires, edits or deletes a rule. Payer sites rate-limit, block
 * bots, move behind WAFs and have bad days; treating a failed fetch as
 * evidence that a payer changed its policy would silently gut the library on
 * a network blip. Every outcome is reported and the operator decides.
 *
 * The distinction it is careful about:
 *   ok          fetched, real text extracted, every quote still found
 *   DRIFTED     fetched, real text extracted, a quote is GONE  <- the finding
 *   unreadable  fetched, but too little text to judge (scanned PDF, JS-only
 *               page, unsupported format) — NOT drift, and not reported as it
 *   unreachable fetch failed (403/404/timeout/DNS) — NOT drift
 *
 * "unreadable" exists because of a bug this codebase has already shipped
 * once: a comparison that returned zero rows on both sides compared equal and
 * reported a clean pass. An empty extraction would mark every quote missing
 * and cry drift across the whole library. So a document must yield real text
 * before its quotes can be judged missing.
 *
 * USAGE
 *   PG_DB=billing_rules PSQL_BIN="psql -h localhost -U postgres" \
 *     node scripts/recheck-source-drift.mjs
 *
 *   --limit N        only the first N documents (by live rules citing, desc)
 *   --url SUBSTRING  only documents whose url contains SUBSTRING
 *   --json PATH      write the full machine-readable report
 *   --quiet          summary only
 *   --explain        for each missing quote, show where it stops matching the
 *                    document — the longest matching prefix, then both sides
 *   --since PATH     compare against a previous --json report and list what
 *                    DEGRADED: a document that was readable and is not any
 *                    more. Losing the ability to check a rule is a change
 *                    worth an email even though it is not a finding.
 *
 * Same PG_DB + PSQL_BIN pair as verify-production.sh / audit-*.sh.
 *
 * EXIT CODES
 *   0  no drift found (unreachable/unreadable documents may still be listed)
 *   1  at least one document no longer contains a quote a live rule cites
 *   2  could not set up (no database, nothing to check)
 * ============================================================================
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Number(argOf('--limit', '0')) || 0;
const URL_FILTER = argOf('--url', null);
const JSON_OUT = argOf('--json', null);
const QUIET = argv.includes('--quiet');
const EXPLAIN = argv.includes('--explain');
const SINCE = argOf('--since', null);

/**
 * How BAD a verdict is, for detecting decay between runs.
 *
 * The weekly job alerts on DRIFTED and SUSPECT — findings against a document.
 * It says nothing when a document we could read last week has become one we
 * cannot, and that is the same loss wearing a quieter label: a payer that
 * starts refusing robots, a file that grows past the size limit, or a URL that
 * stops answering so the check falls back to an archive. Each of those means
 * the library quietly lost the ability to verify rules it could verify before,
 * which is exactly the slow decay this job exists to catch.
 */
const VERDICT_RANK = {
  ok: 0, oversized: 2, blocked: 3, unreachable: 4, unreadable: 5, SUSPECT: 6, DRIFTED: 7,
};
const rankOf = (e) => (e.verdict === 'ok' && e.readVia ? 1 : (VERDICT_RANK[e.verdict] ?? 9));
const describe = (e) => (e.verdict === 'ok' && e.readVia ? 'ok (mirror)' : e.verdict);

const PG_DB = process.env.PG_DB || 'pallio';
const PSQL_BIN = process.env.PSQL_BIN || 'sudo -u postgres psql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Minimum extracted characters before we trust a document enough to judge it. */
const MIN_TEXT = 400;

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------
function psql(sql) {
  const parts = PSQL_BIN.split(/\s+/);
  const bin = parts[0];
  const args = [...parts.slice(1), '-X', '-tAq', '-d', PG_DB, '-c', sql];
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// the same normaliser the library's grounding checks use: forgives layout,
// never forgives a changed word, number, code or negation.
// ---------------------------------------------------------------------------
const norm = (s) => String(s)
  .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u00a0\u2007\u202f]/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/(^|\s)[\u2022\u25cf\u25aa\u00b7\u2043\ufffd]+(?=\s)/g, '$1')
  // ---- Federal Register: two renderings of one document -------------------
  // The same final rule is published as govinfo plain text and as HTML on
  // federalregister.gov, and our quotes came from one while the URL now
  // serves the other. The wording is identical; the typography is not:
  //
  //   govinfo text                     federalregister.gov HTML
  //   [[Page 49404]] mid-sentence      (no pagination markers)
  //   Leukine[supreg]                  Leukine(R)
  //   ``designated ... service''       curly quotes
  //   Sec. 405.2464(g)                 SS 405.2464(g)
  //
  // That put 8 quotes and 45 live rules in the failure column on a page that
  // still contains every one of them \u2014 "designated care management service"
  // occurs ten times in the HTML we fetched. Verified by searching the live
  // page for the substance of each missing quote before writing this.
  //
  // Applied to BOTH sides, so it can only make two renderings of the same
  // sentence comparable; it cannot make two different sentences equal.
  // Pagination markers, in both spellings: govinfo injects "[[Page 49404]]"
  // mid-sentence, federalregister.gov injects "(Printed page 49404)" at the
  // same place. Either one splits a sentence the other keeps whole.
  .replace(/\[\[\s*page\s+[ivxlcdm\d]+\s*\]?\]?/gi, ' ')
  .replace(/\(\s*printed page\s+[\d,]+\s*\)/gi, ' ')
  .replace(/\[(supreg|reg|trade|tm|deg|dagger|ddagger|bull|sect|para|amp)\]/gi, ' ')
  // The section marker before a regulation number does not survive HTML
  // extraction at all \u2014 federalregister.gov emits it as markup the tag
  // stripper removes, so its text reads "at 425.400(c)(1)(x)" where govinfo
  // reads "at Sec. 425.400(c)(1)(x)". Dropped from both sides rather than
  // translated between them: mapping one spelling onto the other still leaves
  // "sec." on the quote side and nothing on the document side. The regulation
  // NUMBER, which is the part that identifies the provision, still has to
  // match. This alone accounted for 6 of the 8 Federal Register quotes.
  .replace(/(^|\s)(\u00a7|sec\.)\s*(?=\d)/gi, '$1')
  .replace(/``|''/g, '"')                                     // TeX-style quoting
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A PDF line break inside a word arrives from pdftotext as "image- guided",
 * and it hides two different originals:
 *   "image-guided"  — a real hyphenated compound, wrapped after the hyphen
 *   "imageguided"   — one word, split with a soft hyphen
 * The same text served as HTML has whichever it really was, so collapsing to
 * a single guess is wrong half the time. Collapsing to "imageguided" is what
 * put 43 Federal Register quotes in the failure column: the live HTML says
 * "image-guided", which normalises to "image-guided", and they never matched.
 *
 * Both readings are tried instead. Only the QUOTE is expanded this way, never
 * the document, so this can surface a true match that formatting hid — it
 * cannot invent one, because both candidates still have to appear verbatim.
 */
const dehyphenations = (q) => {
  const out = new Set([q]);
  if (/[a-z]- [a-z]/.test(q)) {
    out.add(q.replace(/([a-z])- ([a-z])/g, '$1-$2')); // hyphen was real
    out.add(q.replace(/([a-z])- ([a-z])/g, '$1$2'));  // hyphen was a wrap
  }
  // A quote may open with a composed LABEL before the verbatim text:
  //   "Rule SC157 — We limit reimbursement of charges for home visit E/M..."
  // The document carries the sentence, but the label sits several lines
  // above it under other fields (Rule number / Applies to / Category /
  // Topic), so the two are never contiguous. Only a short leading label is
  // stripped — a dash later in the sentence is part of the prose.
  for (const c of [...out]) {
    // A plain hyphen, because norm() has already folded en/em dashes to "-"
    // by the time this runs. Matching [–—] here found nothing.
    const m = /^.{0,80}?\s-\s(.+)$/s.exec(c);
    if (m) out.add(m[1]);
  }
  return [...out];
};

/**
 * Whether a quote still appears, ignoring differences that are artefacts of
 * how we turned the document into text rather than changes to what it says.
 *
 * Stripping tags replaces each one with a SPACE, so text that was adjacent
 * across a tag boundary gains whitespace the quote never had. The Federal
 * Register writes "(<span>3D</span> contour", which becomes "( 3d contour"
 * while the quote says "(3d contour". That single space failed 40 quotes on a
 * page that still contains every word of them — the longest matching prefix
 * was 7 characters, and it stopped exactly at the parenthesis.
 *
 * Removing the tag instead of spacing it would merge words across block
 * boundaries, which is worse. So a whitespace-free comparison is the last
 * resort: every other character must still match, in order, and quotes are
 * long (>15 chars, usually >100), which makes a spurious hit implausible.
 */
/** Only letters and digits — the last-resort comparison. */
const alnum = (s) => s.replace(/[^a-z0-9]/g, '');

/**
 * WHERE does a missing quote stop matching?
 *
 * "This quote is gone" is a verdict, not a lead. Acting on it means finding
 * the point of divergence by hand, and the answer is usually that the payer
 * changed nothing and the two texts are renderings of one document that
 * disagree about a page marker, a symbol or a quotation style. Every drift
 * false positive fixed in this file was diagnosed that way, one at a time, by
 * re-deriving what the tool already knew and would not say.
 *
 * Binary-searches the longest prefix of the quote that still appears, then
 * shows what follows it on each side. --explain prints it.
 */
function divergence(text, q) {
  let lo = 0, hi = q.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (text.includes(q.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  const at = lo ? text.indexOf(q.slice(0, lo)) : -1;
  return {
    matched: lo,
    quote: q.slice(Math.max(0, lo - 30), lo + 60),
    document: at >= 0 ? text.slice(Math.max(0, at + lo - 30), at + lo + 60) : '(no prefix of this quote appears at all)',
  };
}

const stillPresent = (text, textNoWs, q, textAlnum) =>
  dehyphenations(q).some((c) => text.includes(c)
    || textNoWs.includes(c.replace(/\s+/g, ''))
    // Punctuation-blind, for characters pdftotext could not map. Humana's SC
    // code-editing rules extract as "99341 � 99350" and "� 02 � Telehealth":
    // the en-dashes and bullets arrive as U+FFFD, which the normaliser strips
    // as list markers, while the quote's real en-dash becomes "-". Same
    // sentence, never equal. The document plainly still carries Rule SC157
    // verbatim — the place-of-service limit on all eight home-visit codes,
    // which is the one drifted quote that touched a code a biller uses.
    //
    // Safe for the same reason the whitespace form is: every letter and digit
    // must still appear in order, and these quotes run past 100 characters.
    || (textAlnum && textAlnum.includes(alnum(c))));

/**
 * A money field from a fee schedule needs comparing as a NUMBER, not a string.
 * Excel stores 104.10 as the cell value 104.1, so a row citation that reads
 * "payment 104.10" fails a substring test against a workbook that plainly
 * still says 104.1 — the same amount, one trailing zero apart.
 *
 * That produced 21 "Ohio repriced these codes" findings, including 99344 and
 * 99347, which are home-visit codes a biller would act on. Ohio had repriced
 * nothing. Both spellings are tried.
 */
const numericForms = (v) => {
  const out = new Set([v]);
  if (/^\d+\.\d+$/.test(v)) {
    out.add(String(Number(v)));            // 104.10 -> 104.1
    out.add(Number(v).toFixed(2));         // 104.1  -> 104.10
  }
  return [...out];
};

/**
 * Money in a spreadsheet has to be compared as a NUMBER, because a cell holds
 * a binary double and the writer may serialise its full expansion instead of
 * the displayed value:
 *
 *   Ohio Appendix DD   65.49 -> 65.489999999999995   284.59 -> 284.58999999999997
 *   NC fee schedule    28.58 -> 28.579999999999995   19.03  -> 19.029999999999998
 *
 * A row citation reading "payment 65.49" then finds no such substring in a
 * document holding precisely that amount. That is 40 of the 71 quotes this
 * sweep called drift — 20 on Ohio's schedule and 20 on North Carolina's,
 * across five payer copies of each — with the descriptor, effective date and
 * status code all unchanged. Neither state had repriced anything.
 *
 * Expanding the QUOTE is not enough, and that was my first attempt at this.
 * Number('28.58').toPrecision(17) is 28.579999999999998, while the workbook
 * holds 28.579999999999995 — one unit in the last place apart, because the
 * cell is a computed result rather than the nearest double to the printed
 * string. No amount of respelling the quote reaches a value it was never
 * derived from. Rounding both sides to cents does.
 *
 * This is no weaker than the substring test it backs up: that test already
 * accepts the amount appearing ANYWHERE in the document, so matching the same
 * amount numerically grants nothing extra.
 */
const centsInText = (t) => {
  const s = new Set();
  for (const m of t.matchAll(/\d+\.\d+/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) s.add(n.toFixed(2));
  }
  return s;
};

/**
 * Fee-schedule rules do not cite a sentence, because a spreadsheet has none.
 * They cite a ROW, transcribed as
 *   <document>, "<tab>" tab \u2014 99349 | Home visit, established patient | ... | payment 70.13
 * Treating that as a contiguous span marks every one of them missing: 1,036
 * correct rules across four Ohio payers reported as drift on the first run.
 *
 * A row citation is instead verified field by field. The document must still
 * contain the code, the descriptor and any money amount \u2014 which is exactly
 * what would change if the payer altered or withdrew that row, so this still
 * catches the thing worth catching.
 */
const isRowCitation = (q) => q.includes(' | ');

/**
 * A quote containing an ELLIPSIS is not one span, it is several with something
 * deliberately left out between them. Demanding it match contiguously demands
 * the document contain the ellipsis itself, which nothing ever will.
 *
 * The CY2026 Physician Fee Schedule extraction composes quotes this way:
 *   "For CPT code 52648, we proposed to remove the 6 minutes of clinical
 *    labor time for CA021... Since CPT code 52648 is only performed in the
 *    facility setting"
 * where the document reads "...for CA021 (perform procedures/services not
 * directly related to..." and continues for another clause before the second
 * fragment. 11 live Medicare rules cite that way.
 *
 * This was invisible until now, and not because the payer changed anything:
 * those rules cite a 211 MB PDF that was too large to fetch, so their quotes
 * had never once been checked. Giving that document a readable route did not
 * create the finding, it uncovered it — the same quotes would have failed
 * against govinfo itself.
 *
 * Each fragment must still appear verbatim. Fragments under 25 characters are
 * dropped rather than matched: "the facility set" would find a hit in almost
 * any long document and prove nothing.
 */
const ELLIPSIS = /\s*(?:\.\.\.+|…)\s*/;
const isElidedQuote = (q) => ELLIPSIS.test(q);
const elidedFragments = (q) => q.split(ELLIPSIS).map((f) => f.trim()).filter((f) => f.length >= 25);

/**
 * Some row citations assert an ABSENCE, and the absence is the whole point.
 *
 * The three "codes this schedule does not list" seeds prove a gap with an
 * adjacent-code bracket:
 *   SCDHHS Physician Fee Schedule (FEE_P1454) - 99418 | 26.36 followed
 *   directly by 99439 | 31.87; no row for 99425
 * Every number in that line was being required to appear, 99425 included, so
 * the check demanded the very code the citation says is missing. 157 rules
 * reported drift against a schedule that says exactly what they claim.
 *
 * Pulled out and inverted instead: the bracket codes must still be present,
 * and the absent code must still be absent. That verifies the claim rather
 * than skipping it — if SC ever adds 99425, this says so, which is precisely
 * the day those rules need revisiting.
 */
const NEGATED = /\b(?:no row for|not listed|absent|does not (?:appear|list))\s*:?\s*([A-Z]?\d{4,5}[A-Z]?)/gi;

function rowCitationNegatives(quote) {
  return [...String(quote).matchAll(NEGATED)].map((m) => m[1]);
}

function rowCitationFields(quote) {
  // Strip the negated clause before anything else, so its code is not then
  // demanded as evidence of its own presence.
  const fields = String(quote).replace(NEGATED, ' ').split('|').map((f) => f.trim()).filter(Boolean);
  const checkable = [];
  for (let i = 0; i < fields.length; i++) {
    let f = fields[i];
    // The first field carries the document title and tab before the code;
    // keep only what follows the em/en dash separator.
    if (i === 0) {
      const m = f.split(/[\u2014\u2013]\s*/);
      f = m[m.length - 1].trim();
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(f)) continue; // effective dates vary by tab

    // A field that carries a NUMBER is checked on the number, not on the
    // label wrapped around it. "non-facility total RVU 0.32" and "payment
    // 70.13" are how we transcribe a cell; the document holds a columnar
    // 0.32 with the label in a header row far away, so demanding the whole
    // phrase can only fail. That is what put all 307 quotes of the CMS RVU
    // file — 921 rules — in the failure column while the file plainly still
    // contains 36415 and "Coll venous bld venipuncture".
    const nums = f.match(/\d+\.\d+|\b\d{2,}\b/g);
    if (nums) { checkable.push(...nums); continue; }

    // No number and a bare label ("status code X") is unverifiable prose, not
    // evidence — the value it labels is elsewhere in the row.
    //
    // MOD belongs on this list and its absence cost the last unverified
    // document in the library. SC Medicaid's rows are transcribed as
    //   ... | MOD 0 | PAYMENT RATE 36.380000000000003 | ...
    // and "MOD 0" appears nowhere in the workbook as contiguous text: MOD is a
    // column header and 0 is a cell far away from it. 157 rules reported their
    // citation gone against a spreadsheet that plainly still contains 99341,
    // 36.380000000000003 and "SCHEDULE CREATION DATE 5/15/2026" — the exact
    // things the citation is actually asserting. The code and the money are
    // still checked; a one-character modifier never was, because it never
    // appeared next to its label in the first place.
    if (/^(status|payment|code|tab|mod|modifier|proc|procedure|rate|facility|units?|pos|effective|end)\b/i.test(f)) continue;

    if (f.length >= 3) checkable.push(f);
  }
  return checkable;
}

const htmlToText = (h) => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  // NUMERIC entities must be decoded, not dropped. The Federal Register's HTML
  // is full of &#8201; (thin space) and &#8212; (em dash) inside the very
  // sentences our quotes come from. Leaving them as literal "&#8201;" text
  // broke 40 quotes mid-string on a page that genuinely still contains them —
  // 0944T and "image-guided" are both present, they just had an undecoded
  // entity sitting between the words.
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&[a-z]+;/gi, ' ');

/**
 * Some pages ship their body as HTML-escaped markup inside a JSON string
 * inside a <script> tag, and render it client-side. htmlToText drops script
 * blocks whole — correctly, for tracking and configuration — so the document
 * is thrown away and the page reports "only 13 chars of text extracted".
 *
 * Anthem's Ohio prior-authorisation quick guide is exactly that. Its HTML
 * plainly contains the sentence 25 live rules cite:
 *   &lt;li&gt;All unlisted miscellaneous and manually priced codes (including
 *   but not limited to codes ending in 99)&lt;\/li&gt;
 * escaped twice over — once as JSON, once as HTML entities.
 *
 * Used ONLY as a fallback when normal extraction comes out under MIN_TEXT, so
 * a page that renders its content properly is never matched against its own
 * script payload. That restraint matters: a quote found in a configuration
 * blob rather than in the visible document would be a false pass, which is
 * the one kind of error this checker must not make.
 */
const embeddedJsonText = (h) => h
  // JSON string escapes first: \/ -> /, \n -> space, \uXXXX -> the character.
  .replace(/\\u([0-9a-f]{4})/gi, (_, c) => { try { return String.fromCharCode(parseInt(c, 16)); } catch { return ' '; } })
  .replace(/\\n|\\r|\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\//g, '/')
  // Then entities, BEFORE tags are stripped rather than after. That order is
  // the whole trick: the payload lives in an attribute, so &lt;li&gt; is not
  // yet markup and survives, while the <div> wrapping it does not. Decoding
  // afterwards, as htmlToText does, is too late — the tag and everything
  // inside its quotes is already gone. &amp; is decoded last so a
  // double-escaped &amp;lt; does not turn into a tag.
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => { try { return String.fromCodePoint(parseInt(x, 16)); } catch { return ' '; } })
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ').trim();

// --- minimal xlsx reader ----------------------------------------------------
// 1,138 live rules cite spreadsheets. Skipping them would leave a fifth of the
// library unchecked while the report still said "ok", so the zip container is
// walked directly rather than adding a dependency.
function unzipEntries(buf) {
  const out = new Map();
  // End of central directory, scanned backwards (comment may follow it).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + cmtLen;
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch { /* one unreadable member must not kill the document */ }
  }
  return out;
}

function xlsxToText(buf, depth = 0) {
  const entries = unzipEntries(buf);
  if (entries.size === 0) return '';

  // A plain .zip distribution (CMS ships the RVU file this way — 921 live
  // rules cite it) has no xl/ tree of its own; it CONTAINS the workbooks.
  // Without this it extracted 0 characters and was written off as
  // "unreadable", which is honest but leaves a sixth of the library unchecked.
  if (![...entries.keys()].some((k) => k.startsWith('xl/')) && depth < 2) {
    const parts = [];
    for (const [name, data] of entries) {
      if (/\.(xlsx|xlsm)$/i.test(name)) parts.push(xlsxToText(data, depth + 1));
      else if (/\.(txt|csv)$/i.test(name)) parts.push(data.toString('utf8'));
    }
    return parts.join(' ');
  }
  const strings = [];
  const ss = entries.get('xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      strings.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
    }
  }
  const parts = [];
  for (const [name, data] of entries) {
    if (!/^xl\/worksheets\/.*\.xml$/.test(name)) continue;
    const xml = data.toString('utf8');
    // The attribute block is captured whole and t= read out of it separately.
    // A lazy optional group inline (…[^>]*?(?:\st="([^"]*)")?[^>]*…) does NOT
    // reliably capture t when attributes come in the order r,s,t — so every
    // shared-string cell fell through to the numeric branch and emitted its
    // INDEX. The Ohio fee schedule extracted as "99349 5216 45292 2 70.13":
    // codes and money present, not one word of any descriptor. Every
    // text-based quote check against a spreadsheet was doomed to fail.
    // An EMPTY cell is written self-closing: <c r="B10022" s="76"/>. A regex
    // that only knows <c ...>…</c> cannot see it, so the empty cell swallows
    // everything up to the NEXT closing tag — taking the following cell's
    // <v> as its body while contributing its own attributes, which have no
    // t="s". The shared-string index then leaks through as a bare number.
    //
    // NC's fee schedule reads "99349 | 6434 | 103.31" for exactly this
    // reason: 6434 is the index of "Home Visit Est Patient". 128 of 160 NC
    // quotes were reported missing from a file that contains them verbatim.
    // Every workbook with blank cells — which is most of them — was affected.
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = /\bt="([^"]*)"/.exec(c[1])?.[1];
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (type === 's' && v) parts.push(strings[Number(v[1])] ?? '');
      else if (type === 'inlineStr' || type === 'str') {
        parts.push([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('') || (v ? v[1] : ''));
      } else if (v) parts.push(v[1]);
    }
  }
  return parts.join(' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// --- pdf --------------------------------------------------------------------
let PDFTOTEXT = null;
function findPdftotext() {
  if (PDFTOTEXT !== null) return PDFTOTEXT;
  const cands = [process.env.PDFTOTEXT, 'pdftotext'].filter(Boolean);
  // git-for-windows ships poppler under mingw64; the version directory is not
  // always symlinked as "current", so probe the real ones too.
  for (const root of ['C:/Users/S/scoop/apps/git']) {
    try {
      for (const v of fs.readdirSync(root)) cands.push(`${root}/${v}/mingw64/bin/pdftotext.exe`);
    } catch { /* not this machine */ }
  }
  for (const cand of cands) {
    try {
      execFileSync(cand, ['-v'], { stdio: 'ignore' });
      PDFTOTEXT = cand; return cand;
    } catch (e) {
      // `pdftotext -v` prints its banner and exits NON-ZERO on several builds.
      // Only ENOENT means it is genuinely not there — treating a non-zero exit
      // as "missing" is why this reported no pdftotext on a machine that has it.
      if (e && e.code !== 'ENOENT') { PDFTOTEXT = cand; return cand; }
    }
  }
  PDFTOTEXT = false;
  return false;
}

function pdfToText(buf) {
  const exe = findPdftotext();
  if (!exe) return null; // -> unreadable, with a reason, never "drifted"
  const tmp = path.join(os.tmpdir(), `drift-${process.pid}-${Math.abs(hash(buf.length + ':' + buf.length))}.pdf`);
  const txt = tmp.replace(/\.pdf$/, '.txt');
  try {
    fs.writeFileSync(tmp, buf);
    // -raw keeps table cells with their own row; -layout mis-pairs columns,
    // which is how a code once got attached to another code's description.
    execFileSync(exe, ['-raw', tmp, txt], { stdio: 'ignore' });
    return fs.readFileSync(txt, 'utf8');
  } catch {
    return null;
  } finally {
    for (const f of [tmp, txt]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}
const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };

// ---------------------------------------------------------------------------
/**
 * Documents this big cannot be verified on a weekly schedule, and pretending
 * otherwise is what produced three "fetch failed" lines that were not failures.
 * The CY2026 Physician Fee Schedule final rule is 85 MB as a govinfo PDF: it
 * answers HTTP 200 and was still streaming when a 300-second probe gave up, so
 * the 90-second budget aborts it every week and reports it as unreachable.
 * It is not unreachable. It is enormous, and the SAME rule is already verified
 * through its federalregister.gov HTML rendering, which is 7 MB and passes.
 */
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * `bare` sends no headers of our own.
 *
 * Payer origins want a browser User-Agent and refuse a default one. The
 * Internet Archive is the exact opposite: with our spoofed Chrome string it
 * answers 503 with a 107-byte body every time, and with no headers at all it
 * serves the document — a browser UA arriving over a Node TLS fingerprint
 * reads as a bot pretending, which is worse than a bot that says so. Measured
 * four ways: checker headers, plus Accept-Encoding, full browser set, and
 * bare. Only bare returned 200.
 */
/**
 * A NETWORK-level failure is retried; an HTTP answer is not.
 *
 * CareSource serves its two Ohio manuals slowly and drops the connection part
 * way through: curl gets "HTTP/2 stream 1 was not closed cleanly:
 * PROTOCOL_ERROR" and still finishes with 200 and 2.2 MB after 130 seconds,
 * while this process gets undici's "terminated" and reports the document
 * unreachable. 51 live rules on in-scope codes hang off those two files.
 *
 * Raising the timeout did not help, because it was never a timeout — the
 * clock was my first guess and the error text said so once it changed from
 * "aborted" to "terminated". A dropped connection is worth another go; a 403
 * is not, and retrying one would just be knocking harder on a locked door.
 */
/**
 * Hard ceiling on everything spent for one document, retries and curl
 * included. Per-attempt limits are not enough: a host that refuses at the TCP
 * layer can burn its own connect timeout on each try, and three of those plus
 * a curl is however long the operating system feels like taking.
 */
const DOC_BUDGET_MS = 240_000;

async function fetchDoc(url, opts = {}) {
  const startedAt = Date.now();
  const spent = () => Date.now() - startedAt;
  let last = null;
  for (const waitMs of [0, 5000, 15000]) {
    if (waitMs) {
      if (spent() > DOC_BUDGET_MS) return last;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    last = await fetchOnce(url, opts);
    if (last.status !== 0) return last;      // any HTTP answer, including an error, is final
    if (spent() > DOC_BUDGET_MS) return last;

    // A TIMEOUT is not worth repeating, and this is where I nearly buried the
    // weekly job. Three retries at 180 seconds, then curl retrying twice more
    // at 180, is a quarter of an hour spent on one host that is silently
    // dropping packets — and img1.scdhhs.gov does exactly that. The sweep sat
    // there long enough to look hung, because it was.
    //
    // The two failures are already distinguishable and I was not using the
    // distinction: CareSource fails FAST with "terminated" (a dropped
    // connection, which another attempt or curl genuinely fixes), while a
    // blackholed host fails only when the clock runs out. Waiting the full
    // budget twice more tells us nothing we did not know at 180 seconds.
    if (last.timedOut) return last;
  }
  // Three dropped connections in a row, and curl can still get the file.
  //
  // CareSource serves its two Ohio manuals over a connection that undici loses
  // mid-body — "terminated" — while curl reports the same HTTP/2 protocol
  // error, recovers, and finishes with 200 and the whole document. Retrying
  // in-process helped on some runs and not others, which is worse than either
  // outcome: 51 live rules on in-scope codes flickering between verified and
  // unreachable week to week.
  //
  // The archive is no answer here. Its only capture of that manual is the
  // December 2024 edition, and it is missing one of the two sentences these
  // rules cite -- wiring it in would report CareSource as having changed
  // something they have not.
  //
  // So: fall back to curl, which this machine already relies on for nothing
  // but is present wherever pdftotext is. Only after the network has failed
  // outright three times, never in place of an HTTP answer.
  if (spent() > DOC_BUDGET_MS) return last;
  const viaCurl = curlFetch(url, Math.max(20, Math.floor((DOC_BUDGET_MS - spent()) / 1000)));
  if (viaCurl) return viaCurl;
  return last;
}

/**
 * WORST CASE, DELIBERATELY BOUNDED
 *   answered (any status)          one request
 *   dropped connection             3 requests + 20s of waiting, then one curl
 *   silent blackhole (timeout)     ONE request, 180s, then done
 * A weekly job may be slow. It may not look hung, and it did: stacking a
 * 180-second budget, three retries and a curl that retried twice more came to
 * roughly fifteen minutes on a single unreachable host.
 */

function findCurl() {
  for (const cand of ['curl', '/usr/bin/curl', '/bin/curl']) {
    try { execFileSync(cand, ['--version'], { stdio: 'ignore' }); return cand; } catch { /* keep looking */ }
  }
  return null;
}

function curlFetch(url, maxSeconds = 150) {
  const exe = findCurl();
  if (!exe) return null;
  const tmp = path.join(os.tmpdir(), `drift-curl-${process.pid}-${Math.abs(hash(url))}.bin`);
  try {
    // One attempt, no --retry. Node has already tried three times by the point
    // this runs; curl is here because it recovers from a protocol error node
    // cannot, not because more attempts help.
    const out = execFileSync(exe, [
      '-sS', '-L', '--compressed', '--max-time', String(maxSeconds),
      '-A', UA, '-o', tmp, '-w', '%{http_code} %{content_type}', url,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: (maxSeconds + 10) * 1000 });
    const [code, ...ct] = String(out).trim().split(/\s+/);
    const status = Number(code) || 0;
    const buf = fs.existsSync(tmp) ? fs.readFileSync(tmp) : null;
    if (!buf || !buf.length || status < 200 || status >= 300) return null;
    return { status, buf, contentType: ct.join(' ') || '', viaCurl: true };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function fetchOnce(url, { bare = false } = {}) {
  const ctl = new AbortController();
  // 180s, not 90s. CareSource's MyCare manual answers 200 and takes 130
  // seconds to deliver 2.2 MB — with an HTTP/2 PROTOCOL_ERROR on the way —
  // so a 90-second budget reported "fetch failed: This operation was aborted"
  // for a document that is served, just slowly. A weekly job can wait; being
  // told a payer is unreachable when it is merely slow costs more.
  const timer = setTimeout(() => ctl.abort(), 180_000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      ...(bare ? {} : { headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' } }),
    });
    // Checked BEFORE the body is consumed, so an 85 MB download is declined
    // rather than started and abandoned.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      ctl.abort();
      return { status: res.status, buf: null, contentType: res.headers.get('content-type') || '',
               tooLarge: declared };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return { status: res.status, buf: null, contentType: res.headers.get('content-type') || '',
               tooLarge: buf.length };
    }
    // A body SHORTER than the server declared is a truncated download, not a
    // shorter document — and grading one compares a payer's rules against half
    // a page, then reports every quote past the cut as gone. That is not
    // hypothetical: three rows cite the 7 MB Federal Register rendering, all
    // three were read in the same sweep, and one came back short. Its ten
    // Medicare rules were called SUSPECT against a document that had not
    // changed a word. `declared` was already being read here and only ever
    // compared upward, against the size ceiling.
    if (declared > 0 && buf.length < declared) {
      return { status: res.status, buf: null, contentType: res.headers.get('content-type') || '',
               truncated: { got: buf.length, declared } };
    }
    return { status: res.status, buf, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    const msg = String(e.message || e);
    // Distinguishing these two is what keeps the sweep from waiting a quarter
    // of an hour on a host that will never answer.
    const timedOut = ctl.signal.aborted || /abort/i.test(msg);
    return { status: 0, buf: null, contentType: '', timedOut, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function extract(url, contentType, buf) {
  const sniff = buf.subarray(0, 4).toString('latin1');
  if (sniff === '%PDF') return { kind: 'pdf', text: pdfToText(buf), why: findPdftotext() ? null : 'pdftotext not installed' };
  if (sniff.startsWith('PK')) return { kind: 'xlsx', text: xlsxToText(buf), why: null };
  if (/pdf/i.test(contentType)) return { kind: 'pdf', text: pdfToText(buf), why: findPdftotext() ? null : 'pdftotext not installed' };
  const html = buf.toString('utf8');
  const visible = htmlToText(html);
  if (visible.length >= MIN_TEXT) return { kind: 'html', text: visible, why: null };
  const embedded = embeddedJsonText(html);
  if (embedded.length > visible.length) {
    return { kind: 'html+json', text: embedded, why: null };
  }
  return { kind: 'html', text: visible, why: null };
}

// ---------------------------------------------------------------------------
async function main() {
  let docs;
  try {
    const raw = psql(`
      SELECT coalesce(json_agg(row_to_json(d)), '[]')::text FROM (
        SELECT sd.id::text AS id, sd.url, coalesce(p.name,'(no payer)') AS payer,
               -- NOTE: this query is passed to psql with -c, so keep it ASCII.
               -- A non-ASCII character in a comment here is enough to produce
               -- 'invalid byte sequence for encoding "UTF8"' and take the
               -- whole check down.
               --
               -- A document can be readable at an address that is not the one
               -- a biller should be sent to. Medical Mutual's provider manual
               -- forced this: medmutual.com drops packets from this VPS and
               -- from a home connection alike (DNS resolves, TCP never
               -- completes, on 80 and 443), while the manual itself is live
               -- and unchanged, still carrying all seven sentences its 141
               -- live rules cite. The citation must stay on the payer's own
               -- URL, because that is where a biller has to go; the CHECK
               -- needs somewhere it can actually read.
               --
               -- Only ever a route to the SAME document, recorded per document
               -- with how it was established. Never a different document, and
               -- never a guess: an unverifiable citation is better than one
               -- verified against the wrong thing.
               sd.source_metadata->>'verifyVia' AS verify_via,
               count(r.id) AS live_rules,
               -- Each quote with the number of rules that actually cite it, so
               -- the report can say how many rules LOST their citation rather
               -- than how many happen to share a document with a lost one.
               (SELECT coalesce(json_agg(json_build_object('q', q.source_quote, 'n', q.n)), '[]')
                  FROM (SELECT r2.source_quote, count(*) AS n
                          FROM payer_rule r2
                         WHERE r2.source_doc_id = sd.id
                           AND r2.effective_date <= CURRENT_DATE
                           AND (r2.expiration_date IS NULL OR r2.expiration_date > CURRENT_DATE)
                           AND r2.source_quote IS NOT NULL
                           AND length(trim(r2.source_quote)) > 15
                         GROUP BY r2.source_quote) q) AS quotes
          FROM source_document sd
          JOIN payer_rule r ON r.source_doc_id = sd.id
           AND r.effective_date <= CURRENT_DATE
           AND (r.expiration_date IS NULL OR r.expiration_date > CURRENT_DATE)
          LEFT JOIN payer p ON p.id = sd.payer_id
         WHERE sd.url LIKE 'http%'
         GROUP BY sd.id, sd.url, p.name, sd.source_metadata->>'verifyVia'
         HAVING count(r.id) > 0
         ORDER BY count(r.id) DESC
      ) d`);
    docs = JSON.parse(raw.trim() || '[]');
  } catch (e) {
    console.error(`FATAL: cannot reach database '${PG_DB}' with: ${PSQL_BIN}`);
    console.error(String(e.message || e).split('\n').slice(0, 3).join('\n'));
    process.exit(2);
  }

  if (URL_FILTER) docs = docs.filter((d) => d.url.includes(URL_FILTER));
  if (LIMIT) docs = docs.slice(0, LIMIT);
  if (docs.length === 0) { console.error('FATAL: no cited documents to check'); process.exit(2); }

  console.log('='.repeat(78));
  console.log(' SOURCE DRIFT — does each cited document still say what its rules claim?');
  console.log(`   database: ${PG_DB}    documents: ${docs.length}` +
    `    live rules covered: ${docs.reduce((n, d) => n + Number(d.live_rules), 0)}`);
  if (!findPdftotext()) console.log('   note: pdftotext not found — PDFs will report as unreadable, never as drift');
  console.log('='.repeat(78));
  console.log('');

  const report = [];
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < docs.length) {
      const d = docs[cursor++];
      const quotes = (d.quotes || []).filter(Boolean);
      // Try the payer's own URL first, always. The mirror is a fallback, so a
      // document that starts working directly stops depending on one.
      let got = await fetchDoc(d.url);
      let readVia = null;
      // Which fallback host this document leans on, and whether it answered.
      // Recorded even when it fails, because "this document got worse" and
      // "the one host nine documents share is down" look identical in a
      // verdict and could not be told apart without it.
      let mirrorHost = null;
      let mirrorFailed = false;
      // Oversized counts as "could not read it", so it falls back too. The
      // first version excluded it, on the reasoning that a document answering
      // 200 is not a fetch failure and a mirror would mask that. It masks
      // nothing: the 211 MB govinfo PDF is unreadable on a weekly schedule
      // whatever its status code, and its 7 MB HTML rendering is the same
      // Federal Register text. Refusing the mirror there left 22 Medicare
      // rules permanently unverified in order to preserve a label.
      const directUnusable = !got.buf || got.status < 200 || got.status >= 300 || Boolean(got.tooLarge);
      if (d.verify_via && directUnusable) {
        // Headered first, exactly as every other document is fetched, then
        // bare. Bare-first was wrong: it was chosen for the Internet Archive,
        // which refuses our browser User-Agent, and then applied to every
        // mirror. federalregister.gov is an ordinary origin and answers a
        // bare request with something thinner than the article, so the quotes
        // came back missing and a document that matches perfectly was
        // reported DRIFTED. The Archive is the exception; it costs one extra
        // request to treat it as one.
        try { mirrorHost = new URL(d.verify_via).host; } catch { mirrorHost = null; }
        for (const attempt of [{ bare: false }, { bare: true }]) {
          const alt = await fetchDoc(d.verify_via, attempt);
          if (alt.buf && alt.status >= 200 && alt.status < 300) {
            got = alt; readVia = d.verify_via; break;
          }
          await new Promise((r) => setTimeout(r, 4000));
        }
        mirrorFailed = !readVia;
      }
      let entry;
      if (got.tooLarge) {
        // Reachable, answered 200, and too big to verify on a schedule. Saying
        // "fetch failed" about a document that responded correctly sends
        // someone to look for an outage that is not there.
        entry = { ...d, quotes: quotes.length, verdict: 'oversized',
          detail: `HTTP ${got.status}, ${(got.tooLarge / 1048576).toFixed(0)} MB — over the ${(MAX_BYTES / 1048576).toFixed(0)} MB verification limit` };
      } else if (got.status === 403 || got.status === 406 || got.status === 451 || got.status === 429) {
        // The origin refused a robot. That is a standing property of the site,
        // not a change in the document, and it does not resolve itself: nine
        // of this library's documents are permanently in this state, which is
        // why several seeds record "origin blocks automated access" against
        // them. Grouping them with real fetch failures buries the ones worth
        // looking at.
        entry = { ...d, quotes: quotes.length, verdict: 'blocked',
          detail: `HTTP ${got.status} — origin refuses automated clients` };
      } else if (!got.buf || got.status < 200 || got.status >= 300) {
        entry = { ...d, quotes: quotes.length, verdict: 'unreachable',
          detail: got.truncated
            ? `truncated download — received ${got.truncated.got} of the ${got.truncated.declared} bytes the server declared`
            : got.error ? `fetch failed: ${got.error}` : `HTTP ${got.status}` };
      } else {
        const ex = extract(d.url, got.contentType, got.buf);
        const text = norm(ex.text || '');
        if (text.length < MIN_TEXT) {
          entry = { ...d, quotes: quotes.length, verdict: 'unreadable',
            detail: ex.why || `${ex.kind}: only ${text.length} chars of text extracted (needs ${MIN_TEXT})` };
        } else {
          const textNoWs = text.replace(/\s+/g, '');
          const textAlnum = alnum(text);
          const textCents = centsInText(text);
          const missing = quotes.filter(({ q }) => {
            if (!isRowCitation(q) && isElidedQuote(q)) {
              // Every fragment must survive; the gap between them is the
              // author's, not the document's.
              const frags = elidedFragments(norm(q));
              if (!frags.length) return !stillPresent(text, textNoWs, norm(q), textAlnum);
              return frags.some((f) => !stillPresent(text, textNoWs, f, textAlnum));
            }
            if (!isRowCitation(q)) return !stillPresent(text, textNoWs, norm(q), textAlnum);
            // A row citation survives if every checkable field is still there.
            // Row FIELDS are matched without the punctuation-blind fallback:
            // a bare "2.70" stripped to "270" would match far too easily in a
            // document full of numbers. Prose quotes are long enough to be safe.
            // A code the citation says is NOT in the schedule must still not
            // be there. Matched on the bare code, the same way a present code
            // is matched, so "99425" turning up anywhere in the workbook is
            // enough to reopen the question.
            // Matched on a WORD BOUNDARY, not as a substring. stillPresent is
            // a substring test, which is right for a sentence and wrong for a
            // bare five-digit code: SC's schedule holds 19,403 rows of numbers
            // and "99424" turns up inside longer ones. Three absence claims
            // reported drift on codes the workbook does not list, which is the
            // opposite of what they assert.
            for (const absent of rowCitationNegatives(q)) {
              const bare = norm(absent).replace(/[^a-z0-9]/gi, '');
              if (!bare) continue;
              if (new RegExp(`(?<![a-z0-9])${bare}(?![a-z0-9])`, 'i').test(text)) return true;
            }
            return rowCitationFields(q).some((f) => {
              const nf = norm(f);
              if (numericForms(nf).some((v) => stillPresent(text, textNoWs, v))) return false;
              // Money survives if the document still holds the same amount,
              // whatever binary expansion it was written in. See centsInText.
              if (/^\d+\.\d+$/.test(nf) && textCents.has(Number(nf).toFixed(2))) return false;
              return true;
            });
          });
          // EVERY quote gone is a different signal from SOME quotes gone.
          // A payer that revises a page drops a few sentences; a payer does
          // not delete all 307 at once. When nothing matches, the likelier
          // explanation is that this is not the same document — a redirect to
          // a landing or login page, a different rendering (our quotes came
          // from a PDF, the URL now serves HTML), or the wrong member of a
          // zip. Calling that DRIFTED put 1,401 correct rules in the failure
          // column on the first corrected run, which is the same crying-wolf
          // failure as counting spreadsheet rows as sentences.
          //
          // So it is reported as SUSPECT: the check could not be performed,
          // like unreadable and unreachable, rather than a finding against
          // the data. Two or fewer quotes stays DRIFTED — losing both of two
          // is ordinary, and there is no pattern to infer from.
          // A JavaScript-rendered page answers 200 with a lot of HTML and
          // almost no text: the navigation chrome survives tag-stripping and
          // the document does not. CareSource's two Ohio manual pages return
          // 176 KB and 173 KB of HTML that extract to 8 KB of "Skip to main
          // content / Login / Find A Doctor" — enough to clear the readability
          // gate, so every quote is then reported gone and 51 live rules on
          // in-scope codes are told their citation moved. CareSource had
          // changed nothing; the manual is a PDF the page loads by script.
          //
          // Losing EVERY quote off a page whose text is a sliver of its bytes
          // is that failure, not drift. Judging it DRIFTED would tell someone
          // to re-extract or retire rules that are correct.
          const textRatio = got.buf.length ? text.length / got.buf.length : 1;
          const shellOnly = ex.kind === 'html' && textRatio < 0.10;
          const allGone = missing.length === quotes.length && (quotes.length >= 3 || shellOnly);
          entry = { ...d, quotes: quotes.length,
            verdict: missing.length ? (allGone ? 'SUSPECT' : 'DRIFTED') : 'ok',
            kind: ex.kind, textChars: text.length, missingCount: missing.length,
            // Rules whose OWN citation is gone. Summing live_rules across
            // drifted documents said "3,839 rules" when 5 quotes had moved on
            // a document 259 rules happen to share — a number that reads as a
            // catastrophe and describes a handful of rows.
            rulesLosingCitation: missing.reduce((n, m) => n + Number(m.n || 0), 0),
            missingSamples: missing.slice(0, 3).map((m) => String(m.q).slice(0, 150)),
            // The console prints three samples to stay readable. The JSON is
            // what someone acts FROM, and truncating it there means a document
            // reporting "4 of 259 gone" hands you three of the four and no way
            // to get the fourth without re-running the whole sweep. Whole
            // quotes, untruncated, plus how many live rules each one carries,
            // so the report can be worked straight through.
            missingQuotes: missing.map((m) => ({ quote: String(m.q), rules: Number(m.n || 0),
              ...(EXPLAIN ? { divergence: divergence(text, norm(String(m.q))) } : {}) })) };
        }
      }
      delete entry.quotes_raw;
      if (readVia) entry.readVia = readVia;
      if (mirrorHost) entry.mirrorHost = mirrorHost;
      if (mirrorFailed) entry.mirrorFailed = true;
      report.push(entry);
      if (!QUIET) {
        const tag = entry.verdict === 'ok' ? 'ok        '
          : entry.verdict === 'DRIFTED' ? 'DRIFTED   '
          : entry.verdict === 'SUSPECT' ? 'SUSPECT   ' : `${entry.verdict.padEnd(10)}`;
        console.log(`  ${tag} ${String(entry.live_rules).padStart(5)} rules  ${entry.url.slice(0, 80)}`);
        // Said out loud on every run. A quote verified somewhere other than
        // the address the rule cites is a weaker fact than one verified at
        // it, and burying that would make the report claim more than it did.
        if (entry.readVia) console.log(`             read via ${entry.readVia.slice(0, 88)} — the cited URL did not answer`);
        if (entry.verdict === 'DRIFTED' || entry.verdict === 'SUSPECT') {
          console.log(`             ${entry.missingCount} of ${entry.quotes} distinct quote(s) no longer present — ${entry.payer}`);
          for (const s of entry.missingSamples) console.log(`               missing: "${s}"`);
          if (EXPLAIN) {
            for (const m of entry.missingQuotes || []) {
              if (!m.divergence) continue;
              console.log(`               -- diverges after ${m.divergence.matched} chars`);
              console.log(`                  quote....: ...${m.divergence.quote}`);
              console.log(`                  document.: ...${m.divergence.document}`);
            }
          }
        } else if (entry.verdict !== 'ok') {
          console.log(`             ${entry.detail}`);
        }
      }
      await new Promise((r) => setTimeout(r, 250)); // be a polite client
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, docs.length) }, worker));

  const by = (v) => report.filter((r) => r.verdict === v);
  const drifted = by('DRIFTED');
  const suspect = by('SUSPECT');
  const rulesAffected = drifted.reduce((n, d) => n + Number(d.rulesLosingCitation || 0), 0);
  const quotesLost = drifted.reduce((n, d) => n + Number(d.missingCount || 0), 0);

  console.log('');
  console.log('='.repeat(78));
  // A document read through a mirror is NOT the same fact as one read at the
  // address its rules cite, and must not disappear into the same total. The
  // mirror is an archive: it lags the payer, so a manual replaced last month
  // still matches until the archive re-crawls. Counted apart, and named, so
  // "ok" keeps meaning "verified where the citation points".
  const viaMirror = report.filter((r) => r.readVia && r.verdict === 'ok');
  console.log(` ok ............ ${String(by('ok').length - viaMirror.length).padStart(3)} document(s)   verified at the URL the rules cite`);
  if (viaMirror.length) {
    console.log(` ok (mirror) ... ${String(viaMirror.length).padStart(3)} document(s)   quotes still present, but read from an archive because`);
    console.log(`                     the payer's own URL does not answer — lags the live document`);
  }
  console.log(` DRIFTED ....... ${String(drifted.length).padStart(3)} document(s)   ${quotesLost} quote(s) gone, cited by ${rulesAffected} live rule(s)`);
  console.log(` SUSPECT ....... ${String(suspect.length).padStart(3)} document(s)   ${suspect.reduce((n, d) => n + Number(d.live_rules), 0)} rules — EVERY quote gone, so probably not the same document (NOT drift)`);
  console.log(` unreadable .... ${String(by('unreadable').length).padStart(3)} document(s)   (format not parseable here — NOT drift)`);
  console.log(` blocked ....... ${String(by('blocked').length).padStart(3)} document(s)   (origin refuses robots — standing, NOT drift)`);
  console.log(` oversized ..... ${String(by('oversized').length).padStart(3)} document(s)   (answers 200, too large to verify weekly — NOT drift)`);
  console.log(` unreachable ... ${String(by('unreachable').length).padStart(3)} document(s)   (fetch failed — NOT drift)`);
  console.log('='.repeat(78));

  // --- what changed since the last run ------------------------------------
  if (SINCE) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(SINCE, 'utf8')); } catch { /* no usable previous run */ }
    if (!prev || !Array.isArray(prev.report)) {
      console.log('');
      console.log(` no comparable previous run at ${SINCE} — nothing to compare against`);
    } else {
      const before = new Map(prev.report.map((r) => [r.url, r]));
      const today = new Date().toISOString().slice(0, 10);

      // HOW LONG each unhealthy document has been unhealthy, carried forward
      // across runs. A host that blinks out for one morning and a host that
      // has been gone a month produce an identical verdict today; only this
      // date separates them, and treating them the same is what turns a
      // weekly mail into something people filter unread.
      for (const now of report) {
        if (rankOf(now) <= 1) continue;               // ok, or ok through a mirror
        const was = before.get(now.url);
        now.degradedSince = (was && rankOf(was) > 1 && was.degradedSince) ? was.degradedSince : today;
      }

      const worse = [];
      const better = [];
      const gone = [];
      for (const now of report) {
        const was = before.get(now.url);
        if (!was) continue;                       // new document, not a regression
        const d = rankOf(now) - rankOf(was);
        if (d > 0) worse.push({ now, was });
        else if (d < 0) better.push({ now, was });
      }
      for (const was of prev.report) {
        if (!report.some((r) => r.url === was.url)) gone.push(was);
      }

      // A document that cannot be read because its FALLBACK host is down is
      // not evidence about the payer. The payer's own URL was already failing
      // — that is why a mirror was in use at all — so nothing about them
      // changed. Nine documents behind one dead archive is ONE fact, and
      // printing it as nine payers getting worse is how the single real
      // finding in a list gets lost.
      //
      // Grouped by HOST and asked of the host, not of the documents, because
      // "is the archive still down" is the question that decides whether this
      // is news. Asking each document instead would ask the wrong thing
      // twice over: a document already blocked last week is not "worse" this
      // week, so a still-dead archive would vanish from the report entirely
      // after its first appearance — silence that reads as recovery.
      const prevHostFailed = new Set();
      for (const r of prev.report) if (r.mirrorFailed && r.mirrorHost) prevHostFailed.add(r.mirrorHost);

      const byHost = new Map();
      for (const now of report) {
        if (!now.mirrorFailed || !now.mirrorHost) continue;
        // If the payer's OWN url was serving this document directly last run,
        // the news is that the payer stopped — not that the archive did, even
        // though the archive is also down. That is a regression against the
        // payer and belongs in the list above, which is never silenced.
        // Without this, a payer could start refusing us on the same morning
        // the archive went down and buy itself a week of quiet.
        const wasDirect = before.get(now.url);
        if (wasDirect && rankOf(wasDirect) === 0) continue;
        if (!byHost.has(now.mirrorHost)) byHost.set(now.mirrorHost, []);
        byHost.get(now.mirrorHost).push(now);
      }
      const mirrorUrls = new Set([...byHost.values()].flat().map((e) => e.url));
      const ownFault = worse.filter(({ now }) => !mirrorUrls.has(now.url));

      console.log('');
      if (ownFault.length) {
        console.log(` DEGRADED SINCE ${String(prev.checkedAt || '').slice(0, 10)} — ${ownFault.length} document(s) got harder or impossible to verify`);
        for (const { now, was } of ownFault) {
          console.log(`   ${describe(was)} -> ${describe(now)}   ${String(now.live_rules).padStart(4)} rules  ${now.url.slice(0, 74)}`);
          if (now.detail) console.log(`     ${now.detail}`);
        }
      } else if (!byHost.size) {
        console.log(` nothing degraded since ${String(prev.checkedAt || '').slice(0, 10)}`);
      }

      for (const [host, group] of byHost) {
        const rules = group.reduce((n, e) => n + Number(e.live_rules || 0), 0);
        const since = group.map((e) => e.degradedSince).filter(Boolean).sort()[0] || today;
        const persistent = prevHostFailed.has(host);
        console.log(` MIRROR HOST UNAVAILABLE (${persistent ? 'persistent' : 'first run'}) — ${host}`);
        console.log(`   ${group.length} document(s), ${rules} rule(s) fall back to this host, and it did not answer.`);
        console.log('   Their own origins were already failing before this, so this says');
        console.log('   nothing about the payers and nothing about the rules.');
        console.log(`   unverifiable since ${since}${persistent
          ? ' — still down since the previous run, so this fallback route needs replacing'
          : ' — first run to see it down; if it clears by the next run there was nothing to do'}`);
        for (const e of group) {
          const was = before.get(e.url);
          console.log(`     ${was ? `${describe(was)} -> ` : ''}${describe(e)}   ${String(e.live_rules).padStart(4)} rules  ${e.url.slice(0, 66)}`);
        }
      }
      if (better.length) {
        console.log(` improved: ${better.length} document(s)`);
        for (const { now, was } of better) console.log(`   ${describe(was)} -> ${describe(now)}   ${now.url.slice(0, 74)}`);
      }
      if (gone.length) {
        console.log(` no longer cited by any live rule: ${gone.length} document(s)`);
        for (const g of gone) console.log(`   ${g.url.slice(0, 88)}`);
      }
      console.log('='.repeat(78));
    }
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ database: PG_DB, checkedAt: new Date().toISOString(), report }, null, 1));
    console.log(` full report: ${JSON_OUT}`);
  }

  if (drifted.length) {
    console.log('');
    console.log(' A drifted document means the payer changed or replaced the page a rule');
    console.log(' cites. The rule is not necessarily WRONG — but its citation no longer');
    console.log(' proves it, and a biller who clicks through gets something else.');
    console.log(' Nothing was expired. Re-extract from the current document, or retire');
    console.log(' the rule deliberately.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
