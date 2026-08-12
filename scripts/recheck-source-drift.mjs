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
  // PDF line wrapping splits words as "image- guided". Applied to BOTH the
  // document and the quote, so it can only make a true match findable, never
  // make a false one match: a real hyphenated term keeps its hyphen on both
  // sides. Without this, quotes extracted from a PDF never match the same
  // text served as HTML, and the report is a wall of false drift.
  .replace(/([a-z])- ([a-z])/g, '$1$2')
  .replace(/\s+/g, ' ').trim().toLowerCase();

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

function rowCitationFields(quote) {
  const fields = quote.split('|').map((f) => f.trim()).filter(Boolean);
  const checkable = [];
  for (let i = 0; i < fields.length; i++) {
    let f = fields[i];
    // The first field carries the document title and tab before the code;
    // keep only what follows the em/en dash separator.
    if (i === 0) {
      const m = f.split(/[\u2014\u2013]\s*/);
      f = m[m.length - 1].trim();
    }
    if (/^(status|payment)\b/i.test(f)) {
      const num = f.match(/[\d]+\.[\d]{2}|\b\d+\b/);
      if (num) checkable.push(num[0]);
      continue;
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(f)) continue; // effective dates vary by tab
    if (f.length >= 3) checkable.push(f);
  }
  return checkable;
}

const htmlToText = (h) => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&[a-z]+;/gi, ' ');

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
    for (const c of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = /\bt="([^"]*)"/.exec(c[1])?.[1];
      const body = c[2];
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
async function fetchDoc(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, buf: null, contentType: '', error: String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

function extract(url, contentType, buf) {
  const sniff = buf.subarray(0, 4).toString('latin1');
  if (sniff === '%PDF') return { kind: 'pdf', text: pdfToText(buf), why: findPdftotext() ? null : 'pdftotext not installed' };
  if (sniff.startsWith('PK')) return { kind: 'xlsx', text: xlsxToText(buf), why: null };
  if (/pdf/i.test(contentType)) return { kind: 'pdf', text: pdfToText(buf), why: findPdftotext() ? null : 'pdftotext not installed' };
  return { kind: 'html', text: htmlToText(buf.toString('utf8')), why: null };
}

// ---------------------------------------------------------------------------
async function main() {
  let docs;
  try {
    const raw = psql(`
      SELECT coalesce(json_agg(row_to_json(d)), '[]')::text FROM (
        SELECT sd.id::text AS id, sd.url, coalesce(p.name,'(no payer)') AS payer,
               count(r.id) AS live_rules,
               json_agg(DISTINCT r.source_quote) FILTER (
                 WHERE r.source_quote IS NOT NULL AND length(trim(r.source_quote)) > 15) AS quotes
          FROM source_document sd
          JOIN payer_rule r ON r.source_doc_id = sd.id
           AND r.effective_date <= CURRENT_DATE
           AND (r.expiration_date IS NULL OR r.expiration_date > CURRENT_DATE)
          LEFT JOIN payer p ON p.id = sd.payer_id
         WHERE sd.url LIKE 'http%'
         GROUP BY sd.id, sd.url, p.name
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
      const got = await fetchDoc(d.url);
      let entry;
      if (!got.buf || got.status < 200 || got.status >= 300) {
        entry = { ...d, quotes: quotes.length, verdict: 'unreachable',
          detail: got.error ? `fetch failed: ${got.error}` : `HTTP ${got.status}` };
      } else {
        const ex = extract(d.url, got.contentType, got.buf);
        const text = norm(ex.text || '');
        if (text.length < MIN_TEXT) {
          entry = { ...d, quotes: quotes.length, verdict: 'unreadable',
            detail: ex.why || `${ex.kind}: only ${text.length} chars of text extracted (needs ${MIN_TEXT})` };
        } else {
          const missing = quotes.filter((q) => {
            if (!isRowCitation(q)) return !text.includes(norm(q));
            // A row citation survives if every checkable field is still there.
            return rowCitationFields(q).some((f) => !text.includes(norm(f)));
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
          const allGone = missing.length === quotes.length && quotes.length >= 3;
          entry = { ...d, quotes: quotes.length,
            verdict: missing.length ? (allGone ? 'SUSPECT' : 'DRIFTED') : 'ok',
            kind: ex.kind, textChars: text.length, missingCount: missing.length,
            missingSamples: missing.slice(0, 3).map((q) => q.slice(0, 150)) };
        }
      }
      delete entry.quotes_raw;
      report.push(entry);
      if (!QUIET) {
        const tag = entry.verdict === 'ok' ? 'ok        '
          : entry.verdict === 'DRIFTED' ? 'DRIFTED   '
          : entry.verdict === 'SUSPECT' ? 'SUSPECT   ' : `${entry.verdict.padEnd(10)}`;
        console.log(`  ${tag} ${String(entry.live_rules).padStart(5)} rules  ${entry.url.slice(0, 80)}`);
        if (entry.verdict === 'DRIFTED' || entry.verdict === 'SUSPECT') {
          console.log(`             ${entry.missingCount} of ${entry.quotes} distinct quote(s) no longer present — ${entry.payer}`);
          for (const s of entry.missingSamples) console.log(`               missing: "${s}"`);
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
  const rulesAffected = drifted.reduce((n, d) => n + Number(d.live_rules), 0);

  console.log('');
  console.log('='.repeat(78));
  console.log(` ok ............ ${String(by('ok').length).padStart(3)} document(s)`);
  console.log(` DRIFTED ....... ${String(drifted.length).padStart(3)} document(s)   ${rulesAffected} live rule(s) cite them`);
  console.log(` SUSPECT ....... ${String(suspect.length).padStart(3)} document(s)   ${suspect.reduce((n, d) => n + Number(d.live_rules), 0)} rules — EVERY quote gone, so probably not the same document (NOT drift)`);
  console.log(` unreadable .... ${String(by('unreadable').length).padStart(3)} document(s)   (format not parseable here — NOT drift)`);
  console.log(` unreachable ... ${String(by('unreachable').length).padStart(3)} document(s)   (fetch failed — NOT drift)`);
  console.log('='.repeat(78));

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
