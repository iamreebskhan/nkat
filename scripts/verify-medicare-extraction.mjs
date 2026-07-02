/**
 * Verify the platform EXTRACTS and COMPARES the synthetic Medicare final-rule
 * PDF correctly, across varied scenarios — front-to-back, live.
 *
 * Prereqs (operator, one-time — the script can't do these itself):
 *   1. Generate + serve the PDF:
 *        node scripts/gen-medicare-test-pdf.mjs
 *      then rebuild/restart so Next serves public/ →
 *        https://app.pallio.io/test-fixtures/medicare-final-rule-2026.pdf   (must 200)
 *   2. Register it as an ingestion source (binds Medicare + OH so rules persist):
 *        sudo -u postgres psql pallio -f db/seed/ingestion-source-medicare-pdf.sql
 *
 * Then run this (it triggers extraction if CRON_SECRET is set, else assumes
 * the operator already fired the cron), and it will:
 *   A. Trigger POST /api/cron/ingest-documents  (extracts rules from the PDF)
 *   B. Look up each PDF scenario and assert the extracted coverage matches
 *      what the document states  → proves EXTRACTION across scenarios
 *   C. Upload test-fixtures/medicare-org-rulebook.csv (Path B) and assert the
 *      comparison surfaces diff / unverified / new_from_pallio outcomes
 *   D. Build a 1-row CSV whose value equals a REAL extracted rule and assert
 *      it comes back as a green `match`  → proves COMPARISON end-to-end
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io CRON_SECRET=... node scripts/verify-medicare-extraction.mjs
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const CRON = process.env.CRON_SECRET || "";
const DOS = "2026-07-02";

let cookie = "";
const results = [];
const ok = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };
const soft = (n, c, d = "") => console.log(`${c ? "✓ " : "…"} ${n}${d ? "  — " + d : ""}`);
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

// multipart CSV upload → returns uploadId
async function uploadCsv(csvText, filename) {
  const fd = new FormData();
  fd.set("kind", "rulebook");
  fd.set("file", new Blob([csvText], { type: "text/csv" }), filename);
  const r = await fetch(BASE + "/api/rulebook/upload", {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}) },
    body: fd,
    redirect: "manual",
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}
const csvEsc = (v) => `"${String(v).replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;

console.log(`\n████  VERIFY MEDICARE PDF EXTRACTION + COMPARISON → ${BASE}  ████\n`);

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
ok("Medicare payer resolved", !!medicare?.id, medicare ? `${medicare.name}` : "NOT FOUND — check seed");
const payerId = medicare?.id;

// ── 0. PDF must be reachable (the ingester fetches this exact URL) ─────
{
  const u = `${BASE}/test-fixtures/medicare-final-rule-2026.pdf`;
  let served = false, note = "";
  try {
    const r = await fetch(u, { method: "GET" });
    const ab = await r.arrayBuffer();
    served = r.ok && ab.byteLength > 1000 && Buffer.from(ab).subarray(0, 5).toString() === "%PDF-";
    note = `HTTP ${r.status}, ${ab.byteLength} bytes`;
  } catch (e) { note = String(e); }
  ok("test PDF is served (200 + %PDF header)", served, note);
  if (!served) info("→ run: node scripts/gen-medicare-test-pdf.mjs  then rebuild/restart so Next serves public/");
}

// ════════════════════════════════════════════════════════════════════
// A. Trigger extraction (ingest cron). Synchronous — awaits Claude.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ A. Extraction (POST /api/cron/ingest-documents) ████");
if (CRON) {
  const r = await fetch(BASE + "/api/cron/ingest-documents", { method: "POST", headers: { "x-cron-secret": CRON } });
  const j = await r.json().catch(() => null);
  ok("ingest cron accepted", r.ok, `status=${r.status}`);
  if (j?.data) info(`cron summary: checked=${j.data.checked} ingested=${j.data.ingested} unchanged=${j.data.unchanged} errors=${j.data.errors}`);
} else {
  info("CRON_SECRET not set — assuming the operator already fired the cron.");
  info("To trigger here: CRON_SECRET=… BASE_URL=… node scripts/verify-medicare-extraction.mjs");
}

// ════════════════════════════════════════════════════════════════════
// B. Per-scenario extraction check. HARD asserts on the unambiguous
//    coverage determinations; SOFT (informational) on specialty
//    attributes, whose exact attribute label the model may vary.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ B. Extracted rules per scenario (billing lookup) ████");

// Unambiguous coverage determinations — attribute 'covered'.
const HARD = [
  { cpt: "99347", expect: "covered",     label: "home visit 15 min" },
  { cpt: "99348", expect: "covered",     label: "home visit 25 min" },
  { cpt: "99349", expect: "covered",     label: "home visit 40 min" },
  { cpt: "99350", expect: "covered",     label: "home visit 60 min" },
  { cpt: "99453", expect: "not_covered", label: "RPM set-up (excluded)" },
  { cpt: "99251", expect: "not_covered", label: "inpatient consult (Medicare denies)" },
];
async function lookup(cpt, attribute) {
  return (await req("POST", "/api/billing/lookup", { payerId, state: "OH", cptCode: cpt, attribute, dos: DOS })).j?.data;
}
let extractedOk = 0;
for (const sc of HARD) {
  const d = await lookup(sc.cpt, "covered");
  const hit = d?.status === "ok" && d?.source === "structured_rule";
  const correct = hit && d?.coverageStatus === sc.expect;
  ok(`extract ${sc.cpt} → ${sc.expect} (${sc.label})`, correct,
    `status=${d?.status} source=${d?.source} coverage=${d?.coverageStatus}`);
  if (correct) extractedOk++;
}

// Specialty attributes — informational (the model may label these
// slightly differently, and comparison already proves them as
// new_from_pallio below). We just surface what the corpus holds.
console.log("   — specialty attributes (informational) —");
const SOFT = [
  { cpt: "99457", attr: "prior_auth",     label: "RPM mgmt — prior auth" },
  { cpt: "98016", attr: "telehealth",     label: "virtual check-in — telehealth" },
  { cpt: "99454", attr: "frequency_limit", label: "RPM device — frequency limit" },
  { cpt: "99498", attr: "addon_compatible", label: "ACP add-on — bundled" },
];
for (const sc of SOFT) {
  const d = await lookup(sc.cpt, sc.attr);
  soft(`lookup ${sc.cpt}/${sc.attr} (${sc.label})`, d?.source === "structured_rule",
    `status=${d?.status} source=${d?.source} coverage=${d?.coverageStatus}`);
}
info(`${extractedOk}/${HARD.length} coverage determinations extracted correctly`);

// ════════════════════════════════════════════════════════════════════
// C. Comparison (Path B): upload the org rulebook, assert outcomes.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ C. Comparison — org rulebook vs Pallio-extracted (Path B) ████");
const orgCsv = [
  "payer,state,cpt,attribute,coverage,value",
  "Medicare,OH,99350,covered,not_covered,Internal policy: we were denying 60-minute home visits",
  "Medicare,OH,99453,covered,covered,Internal policy: we assumed RPM set-up is covered",
  "Medicare,OH,99251,covered,covered,Internal policy: we billed inpatient consults as covered",
  "Medicare,OH,99406,covered,covered,Internal note: smoking-cessation counseling (not in the CMS rule)",
].join("\n");
const up = await uploadCsv(orgCsv, "medicare-org-rulebook.csv");
const uploadId = up.j?.data?.uploadId;
ok("org rulebook uploaded + parsed", up.s === 201 && !!uploadId, `rows=${up.j?.data?.parsedRowCount} resolvedPayers=${up.j?.data?.resolvedPayers}`);

const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${uploadId}`);
const rows = cmp.j?.data?.rows || [];
const sum = cmp.j?.data?.summary || {};
ok("comparison built", cmp.s === 200 && rows.length > 0, `total=${cmp.j?.data?.total}`);
info(`outcomes: diff=${sum.diff ?? 0} unverified=${sum.unverified ?? 0} new_from_pallio=${sum.new_from_pallio ?? 0} match=${sum.match ?? 0}`);

// The conflicts we planted must surface as diffs (org disagrees w/ Pallio).
const diffCode = (c) => rows.find((r) => r.cptCode === c && r.attribute === "covered" && r.outcome === "diff");
ok("DIFF: 99350 (org not_covered vs Pallio covered)", !!diffCode("99350"));
ok("DIFF: 99453 (org covered vs Pallio not_covered)", !!diffCode("99453"));
ok("DIFF: 99251 (org covered vs Pallio not_covered)", !!diffCode("99251"));
// 99406 isn't in the CMS rule → org has it, Pallio can't verify.
ok("UNVERIFIED: 99406 (org-only, absent from the rule)",
  !!rows.find((r) => r.cptCode === "99406" && r.outcome === "unverified"));
// Pallio extracted covered codes the org omitted → new_from_pallio.
const newCodes = rows.filter((r) => r.outcome === "new_from_pallio").map((r) => r.cptCode);
ok("NEW_FROM_PALLIO surfaces omitted extracted rules", (sum.new_from_pallio ?? 0) >= 1,
  `codes=${Array.from(new Set(newCodes)).join(",") || "(none)"}`);

// ════════════════════════════════════════════════════════════════════
// D. Prove a green MATCH using a REAL extracted value. Take a covered
//    row Pallio surfaced (new_from_pallio) and echo its exact value back
//    as an org row → coverage + value agree → outcome must be `match`.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ D. Green MATCH round-trip (real extracted value) ████");
const donor = rows.find((r) =>
  r.outcome === "new_from_pallio" && r.attribute === "covered" &&
  r.sourceValue?.coverageStatus === "covered" && r.sourceValue?.ruleValue?.answer);
if (!donor) {
  ok("found a covered extracted rule to match against", false, "no covered new_from_pallio row — extraction likely didn't run");
} else {
  const answer = donor.sourceValue.ruleValue.answer;
  info(`using ${donor.cptCode} covered → value="${String(answer).slice(0, 60)}${String(answer).length > 60 ? "…" : ""}"`);
  const matchCsv = [
    "payer,state,cpt,attribute,coverage,value",
    ["Medicare", "OH", donor.cptCode, "covered", "covered", csvEsc(answer)].join(","),
  ].join("\n");
  const mu = await uploadCsv(matchCsv, "medicare-match-demo.csv");
  const mUploadId = mu.j?.data?.uploadId;
  ok("match-demo rulebook uploaded", mu.s === 201 && !!mUploadId);
  const mcmp = await req("GET", `/api/rulebook/comparison?uploadId=${mUploadId}`);
  const mrow = (mcmp.j?.data?.rows || []).find((r) => r.cptCode === donor.cptCode && r.attribute === "covered");
  ok(`MATCH: ${donor.cptCode} covered (identical value ⇒ green)`, mrow?.outcome === "match",
    `outcome=${mrow?.outcome}`);
}

// ════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }
console.log(`\n${failed.length === 0 ? "✅ extraction + comparison verified across scenarios" : "❌ see above (if extraction rows fail, confirm the PDF is served + the source seed applied + cron fired)"}`);
process.exit(failed.length === 0 ? 0 : 1);
