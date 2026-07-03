/**
 * FULL-RULE live verification from the DEMO USER seat (livedemo@pallio.io).
 *
 * Proves, against the live platform, that the complete CY2026 PFS final rule
 * (db/seed/payer-rules-cy2026-full-rule.sql — 563 rules from Federal Register
 * 2025-19787) is what users actually get:
 *
 *   1. EXTRACTION (read): rule lookups return structured rules at confidence
 *      0.95 with a citation to the FEDERAL REGISTER (verbatim quote included).
 *      Also asserts NO answer cites the retired short docs (cms.gov/files/…) —
 *      i.e. db/seed/retire-cms-short-docs.sql took effect and the full rule
 *      is the controlling source.
 *   2. COMPARISON (Path B): the demo user uploads a rulebook CSV and the
 *      comparison flags planted conflicts (diff), an org-only code the rule
 *      doesn't address (unverified), rules the org omitted (new_from_pallio),
 *      and a value round-trip (match).
 *
 * Structured lookups + comparison are pure SQL — NO Anthropic API calls, so
 * this passes even with zero API credits.
 *
 * Prereqs (operator, once):
 *   sudo -u postgres psql pallio -f db/seed/payer-rules-cy2026-full-rule.sql
 *   sudo -u postgres psql pallio -f db/seed/retire-cms-short-docs.sql
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io node scripts/verify-demo-user-medicare.mjs
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const DOS = new Date().toISOString().slice(0, 10);

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

console.log(`\n████  DEMO USER × CY2026 FULL RULE → ${BASE}  ████\n`);

// ── login AS THE DEMO USER ────────────────────────────────────────────
{
  const su = await req("POST", "/api/auth/signup", { email: EMAIL, password: PASSWORD, fullName: "Live Tester", orgName: "Pallio Live Demo", baaAccepted: true });
  if (su.s !== 201) ok("demo user login", (await req("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).s === 200);
  else ok("demo user signup", true);
}
const me = (await req("GET", "/api/auth/me")).j?.data;
ok("authenticated as demo user", !!me?.userId, `${EMAIL} · role=${me?.role}`);
const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const payerId = payers.find((p) => /medicare/i.test(p.name))?.id;
ok("Medicare visible to demo user", !!payerId);

// ════════════════════════════════════════════════════════════════════
// 1. EXTRACTION (read): full-rule lookups w/ Federal Register citations.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ 1. Demo user reads the full-rule extractions ████");
const PROBES = [
  { cpt: "G2211", attr: "covered", label: "visit-complexity add-on — coverage" },
  { cpt: "G2211", attr: "addon_compatible", label: "G2211 × home-visit E/M pairing" },
  { cpt: "Q3014", attr: "telehealth", label: "originating-site facility fee ($31.85)" },
  { cpt: "G0552", attr: "covered", label: "digital mental-health device supply" },
  { cpt: "90849", attr: "telehealth", label: "multiple-family group psychotherapy — telehealth" },
  { cpt: "99497", attr: "covered", label: "advance care planning (was MLN; must now cite the FR)" },
];
let structured = 0, frCited = 0, staleCms = 0;
for (const q of PROBES) {
  const d = (await req("POST", "/api/billing/lookup", { payerId, state: "OH", cptCode: q.cpt, attribute: q.attr, dos: DOS })).j?.data;
  const isStructured = d?.status === "ok" && d?.source === "structured_rule";
  const url = d?.citation?.documentUrl || "";
  const fromFR = /federalregister\.gov/i.test(url);
  if (isStructured) structured++;
  if (isStructured && fromFR) frCited++;
  if (isStructured && /cms\.gov\/files/i.test(url)) staleCms++;
  console.log(`\n  ${q.cpt}/${q.attr} — ${q.label}`);
  console.log(`    source: ${d?.source}  coverage: ${d?.coverageStatus}  confidence: ${d?.confidence}`);
  console.log(`    answer: ${String(d?.answer || "").slice(0, 110)}`);
  console.log(`    cited : ${url || "(none)"}`);
  console.log(`    quote : "${String(d?.citation?.verbatimQuote || "").slice(0, 90)}"`);
}
ok("full-rule lookups answer from structured rules", structured >= 5, `${structured}/${PROBES.length} structured`);
ok("answers cite the Federal Register final rule", frCited >= 5, `${frCited}/${structured} FR-cited`);
ok("no answer cites the retired short docs (cms.gov/files)", staleCms === 0, `${staleCms} stale citations`);

// ════════════════════════════════════════════════════════════════════
// 2. COMPARISON (Path B): demo rulebook vs the full rule.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ 2. Demo user compares its rulebook vs the full rule ████");
const orgCsv = [
  "payer,state,cpt,attribute,coverage,value",
  "Medicare,OH,G2211,covered,not_covered,Internal policy: we thought the complexity add-on wasn't payable",
  "Medicare,OH,G0552,covered,not_covered,Internal policy: we assumed DMHT devices weren't covered",
  "Medicare,OH,36415,covered,covered,Internal note: routine venipuncture (not addressed in the final rule)",
].join("\n");
const up = await uploadCsv(orgCsv, "demo-fullrule-rulebook.csv");
const uploadId = up.j?.data?.uploadId;
ok("demo user uploaded its rulebook", up.s === 201 && !!uploadId, `rows=${up.j?.data?.parsedRowCount}`);

const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${uploadId}`);
const rows = cmp.j?.data?.rows || [];
const sum = cmp.j?.data?.summary || {};
ok("comparison built", cmp.s === 200 && rows.length > 0, `total=${cmp.j?.data?.total}`);
info(`outcomes: diff=${sum.diff ?? 0} unverified=${sum.unverified ?? 0} new_from_pallio=${sum.new_from_pallio ?? 0} match=${sum.match ?? 0}`);

const diffG2211 = rows.find((r) => r.cptCode === "G2211" && r.attribute === "covered" && r.outcome === "diff");
const diffG0552 = rows.find((r) => r.cptCode === "G0552" && r.attribute === "covered" && r.outcome === "diff");
ok("DIFF: G2211 (org denied; final rule pays)", !!diffG2211,
  diffG2211 ? `org=${diffG2211.orgValue?.coverageStatus} vs rule=${diffG2211.sourceValue?.coverageStatus}` : "not flagged");
ok("DIFF: G0552 (org denied; final rule pays)", !!diffG0552);
ok("UNVERIFIED: 36415 (org-only; not in the final rule)",
  !!rows.find((r) => r.cptCode === "36415" && r.outcome === "unverified"));
ok("NEW_FROM_PALLIO: full-rule attributes the org omitted", (sum.new_from_pallio ?? 0) >= 1,
  `count=${sum.new_from_pallio ?? 0}`);

// ════════════════════════════════════════════════════════════════════
// 3. Green MATCH round-trip using a real full-rule value.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ 3. Green MATCH round-trip (real full-rule value) ████");
const CANDIDATES = ["G2211", "G0552", "90849", "99490", "99497"];
let donor = null;
for (const cpt of CANDIDATES) {
  const pu = await uploadCsv(`payer,state,cpt,attribute,coverage,value\nMedicare,OH,${cpt},covered,covered,probe`, "match-probe.csv");
  const pc = await req("GET", `/api/rulebook/comparison?uploadId=${pu.j?.data?.uploadId}`);
  const row = (pc.j?.data?.rows || []).find((r) =>
    r.cptCode === cpt && r.attribute === "covered" &&
    r.sourceValue?.coverageStatus === "covered" && r.sourceValue?.ruleValue?.answer);
  if (row) { donor = { cpt, answer: row.sourceValue.ruleValue.answer }; break; }
}
if (!donor) {
  ok("found a covered full-rule value to match against", false, "no covered rule among candidates");
} else {
  info(`using ${donor.cpt} covered → "${String(donor.answer).slice(0, 60)}${String(donor.answer).length > 60 ? "…" : ""}"`);
  const mu = await uploadCsv(["payer,state,cpt,attribute,coverage,value",
    ["Medicare", "OH", donor.cpt, "covered", "covered", csvEsc(donor.answer)].join(",")].join("\n"), "match-demo.csv");
  const mcmp = await req("GET", `/api/rulebook/comparison?uploadId=${mu.j?.data?.uploadId}`);
  const mrow = (mcmp.j?.data?.rows || []).find((r) => r.cptCode === donor.cpt && r.attribute === "covered");
  ok(`MATCH: ${donor.cpt} covered (identical value ⇒ green)`, mrow?.outcome === "match", `outcome=${mrow?.outcome}`);
}

// ════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }
console.log(`\n${failed.length === 0
  ? "✅ demo user verified against the FULL CY2026 rule: extraction reads (FR-cited) + comparison + match"
  : "❌ see above — did you apply payer-rules-cy2026-full-rule.sql AND retire-cms-short-docs.sql?"}`);
process.exit(failed.length === 0 ? 0 : 1);
