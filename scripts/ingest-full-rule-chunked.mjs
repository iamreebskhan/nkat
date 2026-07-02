/**
 * Ingest a LARGE Medicare ruling (too big for one PDF request) by chunking.
 *
 * The CY2026 PFS final rule is 1,216 pages / 211 MB — 2x the 600-page limit and
 * 6.6x the 32 MB size limit, so no model can take it whole. This splits it into
 * ≤CHUNK_PAGES-page pieces and POSTs each to /api/cron/extract-pdf, which runs
 * the same extractor (now Opus 4.8) + payer_rule writer per chunk. Rules from
 * every chunk merge into the global corpus and go live for all org users.
 *
 * Prereqs on the VPS:
 *   • Medicare payer seeded (db/seed/payer-medicare.sql)
 *   • qpdf + curl installed:  sudo apt-get install -y qpdf curl
 *   • the app rebuilt/restarted so /api/cron/extract-pdf + Opus 4.8 are live
 *
 * Run on the VPS (use your REAL cron secret):
 *   CRON_SECRET=your-secret node scripts/ingest-full-rule-chunked.mjs
 *
 * Env: BASE_URL (login/payer resolve, default app.pallio.io), CRON_URL (extract
 * endpoint, default http://localhost:3020 — bypasses the gateway timeout),
 * RULE_URL, CHUNK_PAGES (default 40), STATE (default OH), DOCTYPE (default
 * cms_pfs), PAYER_ID (skip login if you pass it).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "https://app.pallio.io";
const CRON_URL = process.env.CRON_URL || "http://localhost:3020";
const CRON_RAW = (process.env.CRON_SECRET || "").trim();
const CRON = /^[\x20-\x7E]+$/.test(CRON_RAW) && CRON_RAW !== "…" ? CRON_RAW : "";
const RULE_URL = process.env.RULE_URL || "https://www.govinfo.gov/content/pkg/FR-2025-11-05/pdf/2025-19787.pdf";
const CHUNK_PAGES = parseInt(process.env.CHUNK_PAGES || "40", 10);
const STATE = process.env.STATE || "OH";
const DOCTYPE = process.env.DOCTYPE || "cms_pfs";
const TITLE_BASE = process.env.TITLE || "CMS — CY2026 PFS Final Rule (CMS-1832-F)";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const die = (m) => { console.error(`❌ ${m}`); process.exit(1); };
const has = (cmd) => { try { return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0; } catch { return false; } };
const pdfHeader = (p) => { const fd = openSync(p, "r"); const b = Buffer.alloc(5); readSync(fd, b, 0, 5, 0); closeSync(fd); return b.toString(); };

// ── preflight ─────────────────────────────────────────────────────────
if (!CRON) die("Set CRON_SECRET to your REAL cron secret (not the '…' placeholder).");
if (/^(your[-_]?(real[-_]?)?(cron[-_]?)?secret|<[^>]+>|secret|changeme|placeholder|xxx+)$/i.test(CRON)) {
  die(`CRON_SECRET is a placeholder ("${CRON}") — pass your REAL secret. Resolve it into the env, don't type it:\n` +
      `   export CRON_SECRET=$(grep -hE '^CRON_SECRET=' .env .env.local .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\\''')`);
}
if (!has("qpdf")) die("qpdf not found. Install it:  sudo apt-get install -y qpdf");
if (!has("curl")) die("curl not found. Install it:  sudo apt-get install -y curl");

console.log(`\n████  CHUNKED INGEST → ${RULE_URL}  ████`);
console.log(`extract endpoint: ${CRON_URL}/api/cron/extract-pdf   chunk size: ${CHUNK_PAGES} pages\n`);

// ── resolve Medicare payer id (login as demo, unless PAYER_ID given) ────
let payerId = process.env.PAYER_ID || null;
if (!payerId) {
  let cookie = "";
  const req = async (m, p, b) => {
    const h = { ...(cookie ? { cookie } : {}) };
    let body; if (b !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(b); }
    const r = await fetch(BASE + p, { method: m, headers: h, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie?.() || []) { const x = c.match(/^pallio_session=([^;]*)/); if (x) cookie = `pallio_session=${x[1]}`; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { s: r.status, j };
  };
  const su = await req("POST", "/api/auth/signup", { email: EMAIL, password: PASSWORD, fullName: "Live Tester", orgName: "Pallio Live Demo", baaAccepted: true });
  if (su.s !== 201) { const lg = await req("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD }); if (lg.s !== 200) die(`login failed (${lg.s})`); }
  const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
  payerId = payers.find((p) => /medicare/i.test(p.name))?.id || null;
  if (!payerId) die("No Medicare payer — run db/seed/payer-medicare.sql first.");
  console.log(`Medicare payer: ${payerId}`);
}

// ── download the rule to disk (curl → low memory) ──────────────────────
const dir = mkdtempSync(join(tmpdir(), "pallio-rule-"));
const rulePath = join(dir, "rule.pdf");
console.log(`downloading rule → ${rulePath} …`);
const dl = spawnSync("curl", ["-sSL", "-A", UA, "-o", rulePath, RULE_URL], { timeout: 900_000, stdio: ["ignore", "ignore", "inherit"] });
if (dl.status !== 0 || !existsSync(rulePath)) { rmSync(dir, { recursive: true, force: true }); die(`download failed (curl exit ${dl.status})`); }
if (pdfHeader(rulePath) !== "%PDF-") { rmSync(dir, { recursive: true, force: true }); die("downloaded file is not a PDF"); }
console.log(`  ${(statSync(rulePath).size / 1048576).toFixed(0)} MB`);

// ── split into chunks (qpdf → streaming, low memory) ───────────────────
const chunkDir = join(dir, "chunks");
mkdirSync(chunkDir);
console.log(`splitting into ${CHUNK_PAGES}-page chunks …`);
const sp = spawnSync("qpdf", [`--split-pages=${CHUNK_PAGES}`, rulePath, join(chunkDir, "chunk.pdf")], { timeout: 600_000 });
// qpdf exit 3 = warnings (still produced output); 0 = clean. 2 = error.
if (sp.status === 2 || !readdirSync(chunkDir).length) { console.error(sp.stderr?.toString()?.slice(0, 300)); rmSync(dir, { recursive: true, force: true }); die("qpdf split failed"); }
const chunks = readdirSync(chunkDir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
console.log(`  ${chunks.length} chunks\n`);

// ── POST each chunk to the extract endpoint ────────────────────────────
let totalRules = 0, totalSkipped = 0, dup = 0, done = 0, errors = 0;
for (let i = 0; i < chunks.length; i++) {
  const f = chunks[i];
  const bytes = readFileSync(join(chunkDir, f));
  const fd = new FormData();
  fd.set("file", new Blob([bytes], { type: "application/pdf" }), f);
  fd.set("payerId", payerId);
  fd.set("state", STATE);
  fd.set("documentType", DOCTYPE);
  fd.set("title", `${TITLE_BASE} [chunk ${i + 1}/${chunks.length}: ${f}]`);
  fd.set("url", RULE_URL);
  const tag = `chunk ${String(i + 1).padStart(2)}/${chunks.length} (${(bytes.length / 1048576).toFixed(1)}MB)`;
  try {
    const r = await fetch(CRON_URL + "/api/cron/extract-pdf", { method: "POST", headers: { "x-cron-secret": CRON }, body: fd });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.data) {
      done++;
      if (j.data.alreadyIngested) { dup++; console.log(`  · ${tag} → already ingested`); }
      else {
        totalRules += j.data.ruleCount || 0; totalSkipped += j.data.skipped || 0;
        console.log(`  ✓ ${tag} → ${j.data.ruleCount} rules${j.data.skipped ? ` (${j.data.skipped} skipped)` : ""}`);
      }
    } else if (r.status === 401 || r.status === 503) {
      // Wrong/absent secret — abort now rather than hammer all 31 chunks.
      errors++;
      console.log(`  ✗ ${tag} → ${r.status} ${JSON.stringify(j?.error || j)?.slice(0, 80)}`);
      console.error(`\n❌ Aborting — the extract endpoint rejected the cron secret (${r.status}). ` +
        `Use your REAL CRON_SECRET (not a placeholder), then re-run. The earlier cron runs used the right one.`);
      break;
    } else {
      errors++;
      console.log(`  ✗ ${tag} → ${r.status} ${JSON.stringify(j?.error || j)?.slice(0, 140)}`);
    }
  } catch (e) {
    errors++;
    console.log(`  ✗ ${tag} → ${e.message} (is the app on ${CRON_URL}?)`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n████  DONE  ████`);
console.log(`${totalRules} rules extracted from ${done}/${chunks.length} chunks (${totalSkipped} skipped, ${dup} already-ingested, ${errors} errors)`);
console.log(`Verify:  sudo -u postgres psql pallio -c "SELECT count(*) FROM payer_rule WHERE created_by='crawler:${DOCTYPE}' AND expiration_date IS NULL;"`);
process.exit(errors && !totalRules ? 1 : 0);
