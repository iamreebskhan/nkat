/**
 * Verify the DEMO USER ACCOUNT (livedemo@pallio.io, org_admin) can EXTRACT and
 * COMPARE against the real Medicare ruling — from the org-user seat, not the
 * operator/cron side.
 *
 * What the demo user can actually do (and what this proves):
 *   • EXTRACTION (read): structured rule extraction (PDF → payer_rule) is the
 *     operator/cron path. The demo user *reads* those extracted rules via rule
 *     lookup — and every answer comes back WITH a citation to the CMS document
 *     (source URL + the verbatim quote the rule was extracted from). That's the
 *     demo user pulling an answer straight out of the Medicare ruling.
 *   • COMPARISON: the demo user uploads its own rulebook CSV (Path B) and sees
 *     it compared, cell by cell, against the Medicare-extracted rules.
 *
 * Prereq: the CMS rules must already be extracted (operator side):
 *   scripts/verify-cms-real-extraction.mjs  (or the seed + cron)
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io node scripts/verify-demo-user-medicare.mjs
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const DOS = "2026-07-02";

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

console.log(`\n████  DEMO USER × MEDICARE RULING → ${BASE}  ████\n`);

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
// PART 1 — EXTRACTION (read): the demo user looks up Medicare rules and
// gets the answer PLUS a citation to the CMS ruling it was extracted from.
// ════════════════════════════════════════════════════════════════════
console.log("\n████ 1. Demo user reads rules extracted from the Medicare ruling ████");
const LOOKUPS = [
  { cpt: "99497", attr: "covered", label: "Advance care planning" },
  { cpt: "99498", attr: "covered", label: "ACP, each additional 30 min" },
  { cpt: "G0552", attr: "covered", label: "New CY2026 digital mental-health code" },
  { cpt: "99349", attr: "addon_compatible", label: "Home visit 40 min (G2211 add-on)" },
  { cpt: "92622", attr: "telehealth", label: "Telehealth service" },
];
let cited = 0;
for (const q of LOOKUPS) {
  const d = (await req("POST", "/api/billing/lookup", { payerId, state: "OH", cptCode: q.cpt, attribute: q.attr, dos: DOS })).j?.data;
  const structured = d?.status === "ok" && d?.source === "structured_rule";
  const cite = d?.citation;
  const fromCms = !!cite?.verbatimQuote && /cms\.gov/i.test(cite?.documentUrl || "");
  console.log(`\n  ${q.cpt}/${q.attr} — ${q.label}`);
  console.log(`    coverage : ${d?.coverageStatus}   confidence: ${d?.confidence}   source: ${d?.source}`);
  console.log(`    answer   : ${String(d?.answer || "").slice(0, 100)}`);
  console.log(`    cited    : ${cite?.documentUrl || "(none)"}`);
  console.log(`    quote    : "${String(cite?.verbatimQuote || "").slice(0, 90)}"`);
  if (structured && fromCms) cited++;
}
ok(`demo user got Medicare rules WITH a CMS citation`, cited >= 3, `${cited}/${LOOKUPS.length} answered from a cms.gov-cited rule`);

// ════════════════════════════════════════════════════════════════════
// PART 2 — COMPARISON: the demo user uploads its rulebook and compares
// against the Medicare-extracted rules (Path B).
// ════════════════════════════════════════════════════════════════════
console.log("\n████ 2. Demo user compares its rulebook vs the Medicare rules ████");
const orgCsv = [
  "payer,state,cpt,attribute,coverage,value",
  "Medicare,OH,99497,covered,not_covered,Internal policy: we thought ACP wasn't separately payable",
  "Medicare,OH,99349,covered,not_covered,Internal policy: we were denying 40-minute home visits",
  "Medicare,OH,99406,covered,covered,Internal note: smoking-cessation counseling (not in these CMS docs)",
].join("\n");
const up = await uploadCsv(orgCsv, "demo-user-rulebook.csv");
const uploadId = up.j?.data?.uploadId;
ok("demo user uploaded its rulebook", up.s === 201 && !!uploadId, `rows=${up.j?.data?.parsedRowCount}`);

const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${uploadId}`);
const rows = cmp.j?.data?.rows || [];
const sum = cmp.j?.data?.summary || {};
ok("comparison built for the demo user", cmp.s === 200 && rows.length > 0, `total=${cmp.j?.data?.total}`);
info(`outcomes: diff=${sum.diff ?? 0} unverified=${sum.unverified ?? 0} new_from_pallio=${sum.new_from_pallio ?? 0} match=${sum.match ?? 0}`);

// The planted conflict must surface (org denied ACP; Medicare pays it).
const diff = rows.find((r) => r.cptCode === "99497" && r.outcome === "diff");
ok("comparison flags the org's ACP conflict (99497)", !!diff,
  diff ? `org=${diff.orgValue?.coverageStatus} vs Pallio=${diff.sourceValue?.coverageStatus}` : "not found");
ok("comparison surfaces Medicare rules the org is missing", (sum.new_from_pallio ?? 0) >= 1, `new_from_pallio=${sum.new_from_pallio ?? 0}`);

// ════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }
console.log(`\n${failed.length === 0 ? "✅ demo user extracts (reads w/ CMS citation) AND compares against the Medicare ruling" : "❌ see above — if lookups are empty, run scripts/verify-cms-real-extraction.mjs first to extract"}`);
process.exit(failed.length === 0 ? 0 : 1);
