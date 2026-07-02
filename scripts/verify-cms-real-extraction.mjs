/**
 * Verify the platform extracts + compares against the REAL CMS ruling PDFs,
 * front-to-back, live.
 *
 * Prereqs (operator, one-time — the script can't do these itself):
 *   1. Fetch + self-host the real CMS PDFs:
 *        node scripts/fetch-cms-real-pdfs.mjs
 *      (rebuild/restart if your Next build doesn't serve public/ live)
 *   2. Register them as ingestion sources (Medicare + OH):
 *        sudo -u postgres psql pallio -f db/seed/ingestion-source-cms-real.sql
 *
 * Then run this (triggers extraction if CRON_SECRET is set, else assumes the
 * operator already fired the cron). It will:
 *   A. Confirm the 4 self-hosted CMS PDFs are actually served
 *   B. Trigger POST /api/cron/ingest-documents (extracts from the real PDFs)
 *   C. Look up real CMS codes and confirm the corpus now answers from
 *      structured rules → proves EXTRACTION from the real documents
 *   D. Upload test-fixtures/cms-org-rulebook.csv and confirm the comparison
 *      surfaces diff / unverified / new_from_pallio
 *   E. Round-trip a real extracted value back to prove a green `match`
 *
 * Real CMS docs are less deterministic than a synthetic fixture, so the
 * extraction check is a THRESHOLD (≥ MIN_HITS codes resolved), not a
 * per-code assertion.
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io CRON_SECRET=… node scripts/verify-cms-real-extraction.mjs
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const CRON = process.env.CRON_SECRET || "";
const DOS = "2026-07-02";
const MIN_HITS = 3; // ≥ this many real CMS codes must resolve to structured_rule

let cookie = "";
const results = [];
const ok = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };
const info = (m) => console.log(`   · ${m}`);

async function req(m, p, b) {
  const h = { ...(cookie ? { cookie } : {}) };
  let body;
  if (b !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(b); }
  const r = await fetch(BASE + p, { method: m, headers: h, body, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) { const x = c.match(/^pallio_session=([^;]*)/); if (x) cookie = `pallio_session=${x[1]}`; }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}
async function uploadCsv(csvText, filename) {
  const fd = new FormData();
  fd.set("kind", "rulebook");
  fd.set("file", new Blob([csvText], { type: "text/csv" }), filename);
  const r = await fetch(BASE + "/api/rulebook/upload", { method: "POST", headers: { ...(cookie ? { cookie } : {}) }, body: fd, redirect: "manual" });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}
const csvEsc = (v) => `"${String(v).replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;

console.log(`\n████  VERIFY REAL-CMS EXTRACTION + COMPARISON → ${BASE}  ████\n`);

// ── login ────────────────────────────────────────────────────────────
{
  const su = await req("POST", "/api/auth/signup", { email: EMAIL, password: PASSWORD, fullName: "Live Tester", orgName: "Pallio Live Demo", baaAccepted: true });
  if (su.s !== 201) ok("login", (await req("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).s === 200);
  else ok("signup", true);
}
const me = (await req("GET", "/api/auth/me")).j?.data;
ok("authenticated", !!me?.userId, `role=${me?.role}`);
const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const medicare = payers.find((p) => /medicare/i.test(p.name));
ok("Medicare payer resolved", !!medicare?.id, medicare?.name);
const payerId = medicare?.id;

// ── A. self-hosted CMS PDFs must be served ───────────────────────────
console.log("\n████ A. Self-hosted CMS PDFs are served ████");
const PDFS = [
  "mm14315-pfs-final-rule-summary-cy2026.pdf",
  "mln901705-telehealth-rpm.pdf",
  "mln006764-evaluation-management.pdf",
  "mln909289-advance-care-planning.pdf",
];
let served = 0;
for (const f of PDFS) {
  const u = `${BASE}/test-fixtures/cms/${f}`;
  let good = false, note = "";
  try {
    const r = await fetch(u);
    const ab = await r.arrayBuffer();
    good = r.ok && ab.byteLength > 1000 && Buffer.from(ab).subarray(0, 5).toString() === "%PDF-";
    note = `HTTP ${r.status}, ${(ab.byteLength / 1024).toFixed(0)} KB`;
  } catch (e) { note = String(e); }
  ok(`served: ${f}`, good, note);
  if (good) served++;
}
if (served < PDFS.length) info("→ run: node scripts/fetch-cms-real-pdfs.mjs  then rebuild/restart so Next serves public/");

// ════════════════════════════════════════════════════════════════════
// B. Trigger extraction (synchronous — awaits Claude on each PDF).
// ════════════════════════════════════════════════════════════════════
console.log("\n████ B. Extraction (POST /api/cron/ingest-documents) ████");
if (CRON) {
  const r = await fetch(BASE + "/api/cron/ingest-documents", { method: "POST", headers: { "x-cron-secret": CRON } });
  const j = await r.json().catch(() => null);
  ok("ingest cron accepted", r.ok, `status=${r.status}`);
  if (j?.data) info(`cron: checked=${j.data.checked} ingested=${j.data.ingested} unchanged=${j.data.unchanged} errors=${j.data.errors}`);
  if (j?.data?.errors > 0) info("⚠ some sources errored — check ingestion_source.last_error (CMS 403? PDF not served?)");
} else {
  info("CRON_SECRET not set — assuming the operator already fired the cron.");
}

// ════════════════════════════════════════════════════════════════════
// C. Extraction check — real CMS codes should now answer from the corpus.
//    Threshold, not per-code assertion (real docs vary).
// ════════════════════════════════════════════════════════════════════
console.log("\n████ C. Real CMS codes extracted into the corpus ████");
const CODES = [
  { cpt: "99347", label: "home visit 15 min" },
  { cpt: "99348", label: "home visit 25 min" },
  { cpt: "99349", label: "home visit 40 min" },
  { cpt: "99350", label: "home visit 60 min" },
  { cpt: "99497", label: "advance care planning" },
  { cpt: "99498", label: "ACP add-on" },
  { cpt: "99457", label: "RPM management" },
  { cpt: "99458", label: "RPM management +20" },
];
let hits = 0;
for (const c of CODES) {
  const d = (await req("POST", "/api/billing/lookup", { payerId, state: "OH", cptCode: c.cpt, attribute: "covered", dos: DOS })).j?.data;
  const structured = d?.status === "ok" && d?.source === "structured_rule";
  console.log(`${structured ? "✓ " : "· "} ${c.cpt} (${c.label}) → source=${d?.source} coverage=${d?.coverageStatus}`);
  if (structured) hits++;
}
ok(`≥ ${MIN_HITS} real CMS codes extracted to structured rules`, hits >= MIN_HITS, `${hits}/${CODES.length} resolved from corpus`);

// ════════════════════════════════════════════════════════════════════
// D. Comparison (Path B) — org rulebook vs the real extracted CMS rules.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ D. Comparison — org rulebook vs real CMS-extracted rules ████");
const orgCsv = [
  "payer,state,cpt,attribute,coverage,value",
  "Medicare,OH,99349,covered,not_covered,Internal policy: we were denying 40-minute home visits",
  "Medicare,OH,99350,covered,not_covered,Internal policy: we were denying 60-minute home visits",
  "Medicare,OH,99497,covered,not_covered,Internal policy: we thought advance care planning wasn't separately payable",
  "Medicare,OH,99406,covered,covered,Internal note: smoking-cessation counseling (not in these CMS docs)",
].join("\n");
const up = await uploadCsv(orgCsv, "cms-org-rulebook.csv");
const uploadId = up.j?.data?.uploadId;
ok("org rulebook uploaded + parsed", up.s === 201 && !!uploadId, `rows=${up.j?.data?.parsedRowCount}`);

const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${uploadId}`);
const rows = cmp.j?.data?.rows || [];
const sum = cmp.j?.data?.summary || {};
ok("comparison built", cmp.s === 200 && rows.length > 0, `total=${cmp.j?.data?.total}`);
info(`outcomes: diff=${sum.diff ?? 0} unverified=${sum.unverified ?? 0} new_from_pallio=${sum.new_from_pallio ?? 0} match=${sum.match ?? 0}`);

ok("DIFF surfaced (org disagrees with real CMS coverage)", (sum.diff ?? 0) >= 1,
  `diff codes=${rows.filter((r) => r.outcome === "diff").map((r) => r.cptCode).join(",") || "(none)"}`);
ok("UNVERIFIED surfaced (99406 — org-only, not in CMS docs)",
  !!rows.find((r) => r.cptCode === "99406" && r.outcome === "unverified"));
ok("NEW_FROM_PALLIO surfaced (real CMS codes the org omitted)", (sum.new_from_pallio ?? 0) >= 1,
  `count=${sum.new_from_pallio ?? 0}`);

// ════════════════════════════════════════════════════════════════════
// E. Green MATCH round-trip using a real extracted value.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ E. Green MATCH round-trip (real extracted value) ████");
const donor = rows.find((r) =>
  r.outcome === "new_from_pallio" && r.attribute === "covered" &&
  r.sourceValue?.coverageStatus === "covered" && r.sourceValue?.ruleValue?.answer);
if (!donor) {
  ok("found a covered extracted rule to match against", false, "no covered new_from_pallio row — extraction likely didn't run");
} else {
  const answer = donor.sourceValue.ruleValue.answer;
  info(`using ${donor.cptCode} covered → "${String(answer).slice(0, 60)}${String(answer).length > 60 ? "…" : ""}"`);
  const matchCsv = ["payer,state,cpt,attribute,coverage,value",
    ["Medicare", "OH", donor.cptCode, "covered", "covered", csvEsc(answer)].join(",")].join("\n");
  const mu = await uploadCsv(matchCsv, "cms-match-demo.csv");
  const mcmp = await req("GET", `/api/rulebook/comparison?uploadId=${mu.j?.data?.uploadId}`);
  const mrow = (mcmp.j?.data?.rows || []).find((r) => r.cptCode === donor.cptCode && r.attribute === "covered");
  ok(`MATCH: ${donor.cptCode} covered (identical value ⇒ green)`, mrow?.outcome === "match", `outcome=${mrow?.outcome}`);
}

// ════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }
console.log(`\n${failed.length === 0 ? "✅ real-CMS extraction + comparison verified" : "❌ see above (if extraction fails: confirm downloader ran, PDFs served, source seed applied, cron fired)"}`);
process.exit(failed.length === 0 ? 0 : 1);
