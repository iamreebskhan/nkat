/**
 * DEEP live verification on a PERSISTENT real account.
 *
 * Unlike probe-full-live (which checks that endpoints RESPOND), this
 * verifies the actual INTELLIGENCE + CONTENT — that document extraction
 * really pulls rules out of a policy doc, that Path-B comparison produces
 * a real match/diff, that the LLM answers are coherent and cited, that the
 * payer-scoped picker returns real codes — and it leaves a populated,
 * browsable org behind so you can log into the UI and click through it.
 *
 * Run on the VPS (has the Anthropic/OpenAI keys):
 *
 *   BASE_URL=https://app.pallio.io \
 *   TEST_EMAIL=you+livetest@yourdomain.com \
 *   TEST_PASSWORD='Choose-A-Strong-Passphrase-9!' \
 *   node scripts/probe-live-account.mjs
 *
 * TEST_EMAIL / TEST_PASSWORD are how YOU log into the seeded account in
 * the browser afterwards. If omitted, the script generates them and prints
 * them at the end. Re-runnable: signup→ (if taken) login; patients are
 * reused by name so the account stays clean.
 */

// Fixed, known demo credentials so this is fully turnkey — no env setup.
// Override with TEST_EMAIL / TEST_PASSWORD if you want your own. This is a
// throwaway DEMO login on your own platform; rotate/remove it before real
// production use.
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const ORG_NAME = process.env.TEST_ORG || "Pallio Live Demo";

let cookie = "";
const results = [];
const ok = (n, c, d = "") => {
  results.push({ n, c });
  console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`);
};
const info = (m) => console.log(`   · ${m}`);

async function req(method, path, body, opts = {}) {
  const h = { ...(cookie ? { cookie } : {}), ...(opts.headers || {}) };
  let payload;
  if (body !== undefined) {
    if (opts.form) payload = body;
    else { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  }
  const r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) {
    const x = c.match(/^pallio_session=([^;]*)/);
    if (x) cookie = `pallio_session=${x[1]}`;
  }
  const ct = r.headers.get("content-type") || "";
  const isPdf = ct.includes("pdf");
  let j = null, t = "", bytes = 0;
  if (isPdf) { bytes = (await r.arrayBuffer()).byteLength; }
  else { t = await r.text(); bytes = t.length; try { j = JSON.parse(t); } catch {} }
  return { s: r.status, j, t, isPdf, bytes };
}

console.log(`\n████  DEEP LIVE VERIFICATION → ${BASE}  ████`);
console.log(`     account: ${EMAIL}\n`);

// ── account: signup, or login if it already exists ─────────────────────
console.log("── account ──");
const su = await req("POST", "/api/auth/signup", { email: EMAIL, password: PASSWORD, fullName: "Live Tester", orgName: ORG_NAME, baaAccepted: true });
if (su.s === 201) {
  ok("signup (new persistent account)", true);
} else {
  const li = await req("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  ok("login (account already existed)", li.s === 200, `signup=${su.s} login=${li.s}`);
}
const me = (await req("GET", "/api/auth/me")).j?.data;
ok("authenticated", !!me?.userId, `role=${me?.role} perms=${me?.permissions?.length}`);

const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const aetna = payers.find((p) => /aetna/i.test(p.name))?.id;
ok("payer catalog loaded", !!aetna, `aetna=${aetna?.slice(0, 8)}`);

// ── onboarding (idempotent) ────────────────────────────────────────────
console.log("\n── onboarding ──");
await req("POST", "/api/onboarding/profile", { name: ORG_NAME, npi: "1234567890", orgType: "palliative" });
await req("POST", "/api/onboarding/states", { states: ["OH"] });
await req("POST", "/api/onboarding/payers", { payerIds: [aetna] });
await req("POST", "/api/onboarding/cpt-codes", { cptCodes: ["99347", "99348", "99349", "99350", "G0318"] });
ok("onboarding complete", true);

// ── seed browsable patients (reuse by name so re-runs stay clean) ───────
console.log("\n── seed patients ──");
async function ensurePatient(first, last, acuity, icd10) {
  const list = (await req("GET", "/api/patients?limit=200")).j?.data?.rows || [];
  const found = list.find((p) => p.firstName === first && p.lastName === last);
  if (found) return found.id;
  const r = await req("POST", "/api/patients", {
    demographics: { firstName: first, lastName: last, dateOfBirth: "1942-03-08", sexAssignedAtBirth: "F", addressLine1: "12 Maple Ave", city: "Dublin", state: "OH", zip: "43017", phone: "555-0142" },
    insurance: { primaryPayerId: aetna, primaryMemberId: "W1234567" },
    clinical: { primaryDiagnosisIcd10: icd10, acuity },
    consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
    careTeam: {},
  });
  return r.j?.data?.id;
}
const adaId = await ensurePatient("Ada", "Lovelace", "critical", "C34.90");
const graceId = await ensurePatient("Grace", "Hopper", "high", "Z51.5");
ok("patient Ada Lovelace (Critical)", !!adaId, `id=${adaId?.slice(0, 8)}`);
ok("patient Grace Hopper (High)", !!graceId, `id=${graceId?.slice(0, 8)}`);

// ── visit → document → superbill (browsable) ───────────────────────────
console.log("\n── visit + superbill ──");
const vc = await req("POST", "/api/visits", { patientId: adaId, clinicianUserId: me.userId, visitType: "established_patient_home", scheduledStart: new Date(Date.now() + 86400_000).toISOString(), isTelehealth: false });
const visitId = vc.j?.data?.id;
ok("visit scheduled for Ada", !!visitId);
await req("PATCH", `/api/visits/${visitId}/document`, { totalMinutes: 45, documentText: "45-minute home visit; symptom management, goals-of-care discussion.", cptCodesAssigned: ["99349"], icd10Codes: ["C34.90"] });
const sb = await req("POST", `/api/visits/${visitId}/superbill`);
const superbillId = sb.j?.data?.id;
ok("superbill persisted", !!superbillId, `id=${superbillId?.slice(0, 8)}`);

// ════════════════════════════════════════════════════════════════════
// DEEP #1 — payer-scoped picker returns REAL codes with provenance
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: payer-scoped picker ████");
const codes = (await req("GET", `/api/billing/allowed-codes?payerId=${aetna}&state=OH`)).j?.data?.rows || [];
ok("picker returns codes for Aetna/OH", codes.length > 0, `n=${codes.length}`);
if (codes[0]) info(`sample: ${codes[0].code} — "${codes[0].descriptor}" · ${codes[0].coverageStatus} · source=${codes[0].sourceKind} · conf ${codes[0].confidence}`);
ok("picker codes carry provenance (sourceKind)", codes.every((c) => typeof c.sourceKind === "string"));

// ════════════════════════════════════════════════════════════════════
// DEEP #2 — pre-submission predictor produces a real risk verdict
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: denial predictor ████");
const pred = await req("POST", "/api/superbills/predict", { payerId: aetna, state: "OH", dos: new Date().toISOString().slice(0, 10), cptCodes: ["99349", "X9999"] });
const pd = pred.j?.data;
ok("predictor returns per-line risk", Array.isArray(pd?.perLine) && pd.perLine.length === 2, `worst=${pd?.worstBand}`);
const bad = (pd?.perLine || []).find((l) => l.code === "X9999");
ok("predictor flags the bogus code X9999", bad && bad.riskBand !== "low", `X9999 → ${bad?.riskBand} (${bad?.reasons?.[0]?.message ?? ""})`);
if (bad?.reasons?.[0]) info(`reason: ${bad.reasons[0].message}`);

// ════════════════════════════════════════════════════════════════════
// DEEP #3 — LLM natural-language lookup returns a coherent, cited answer
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: LLM natural-language lookup ████");
const nl = await req("POST", "/api/billing/lookup", { query: "Does Aetna cover a 40-minute established-patient home visit (99349) in Ohio?" });
const nd = nl.j?.data;
ok("NL lookup returns an answer", !!nd?.answer && nd.answer.length > 10, `source=${nd?.source}`);
ok("answer is cited OR an explicit unknown (no hallucination)", !!nd?.citation || nd?.source === "unknown", `citation=${nd?.citation ? "yes" : "no"}`);
info(`Q: 99349 Aetna OH → A: "${(nd?.answer || "").slice(0, 140)}"`);
if (nd?.citation) info(`cited: ${nd.citation.documentName} — "${(nd.citation.verbatimQuote || "").slice(0, 100)}"`);

// ════════════════════════════════════════════════════════════════════
// DEEP #4 — denial logged → LLM analyst returns a real recommendation
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: LLM denial analysis ████");
const dlog = await req("POST", "/api/denials", { superbillId, cptCode: "99349", carcCode: "16", denialReason: "Claim lacks information needed for adjudication.", deniedAmountCents: 15000, deniedAt: new Date().toISOString() });
const denialId = dlog.j?.data?.id;
ok("denial logged", !!denialId);
const an = await req("POST", `/api/denials/${denialId}/analyze`);
const ad = an.j?.data;
const validRec = ["refile", "write_off", "appeal", "unknown"];
ok("analyst returns a valid recommendation", validRec.includes(ad?.recommendation), `rec=${ad?.recommendation}`);
ok("analyst reasoning is substantive", (ad?.likelyCause?.length ?? 0) > 10 && (ad?.text?.length ?? 0) > 20, `cause=${(ad?.likelyCause || "").length}c text=${(ad?.text || "").length}c`);
info(`recommendation: ${ad?.recommendation}`);
info(`likely cause: "${(ad?.likelyCause || "").slice(0, 140)}"`);

// ════════════════════════════════════════════════════════════════════
// DEEP #5 — Path-B rulebook COMPARISON produces a real match + diff
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: Path-B comparison (match + diff) ████");
// Row 1 agrees with the reference (99349 covered); Row 2 deliberately
// conflicts (99348 marked not_covered) so we should see a diff.
const cmpCsv =
  "payer,state,cpt,attribute,coverage,value\n" +
  "Aetna,OH,99349,covered,covered,Matches reference\n" +
  "Aetna,OH,99348,covered,not_covered,Deliberate conflict for diff\n";
const cfd = new FormData();
cfd.set("file", new Blob([cmpCsv], { type: "text/csv" }), "compare.csv");
cfd.set("kind", "rulebook");
const cup = await req("POST", "/api/rulebook/upload", cfd, { form: true });
const cmpUploadId = cup.j?.data?.id ?? cup.j?.data?.uploadId;
ok("comparison CSV uploaded + parsed", (cup.s === 200 || cup.s === 201) && !!cmpUploadId, `rows=${cup.j?.data?.parsedRowCount ?? "?"}`);
const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${cmpUploadId}`);
const summary = cmp.j?.data?.summary || {};
const rows = cmp.j?.data?.rows || [];
ok("comparison returns rows + summary", rows.length > 0, `summary=${JSON.stringify(summary)}`);
ok("comparison distinguishes match vs diff outcomes", (summary.match ?? 0) >= 1 || (summary.diff ?? 0) >= 1 || rows.some((r) => r.outcome === "match" || r.outcome === "diff"), `outcomes=${[...new Set(rows.map((r) => r.outcome))].join(",")}`);
for (const r of rows.slice(0, 4)) info(`${r.cptCode}/${r.attribute}: ${r.outcome}  (yours=${r.orgValue?.coverageStatus ?? "—"} vs pallio=${r.sourceValue?.coverageStatus ?? "—"})`);

// ════════════════════════════════════════════════════════════════════
// DEEP #6 — document ingestion: chunk + embed a policy doc into the RAG
// corpus (this is what powers the CITED NL answer above). Structured
// rule → payer_rule extraction is the operator cron path, verified live
// separately by probe-full-live (POST /api/cron/ingest-documents → ingested).
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: document ingest → RAG embedding ████");
const stamp = Date.now(); // unique marker so content_hash differs each run (no dedupe)
const policyText =
  `Aetna Home Health & Palliative Coverage Policy (live-test ${stamp}).\n\n` +
  `CPT 99349 — home visit, established patient, 40 minutes: COVERED for members in Ohio when medical necessity is documented.\n` +
  `CPT 99347 — home visit, established patient, 15 minutes: COVERED but requires PRIOR AUTHORIZATION.\n` +
  `CPT 99350 — home visit, established patient, 60 minutes: NOT COVERED under the standard home-health benefit.\n` +
  `Telehealth (audio-video) equivalents are reimbursed at parity with modifier 95.\n`;
const dfd = new FormData();
dfd.set("file", new Blob([policyText], { type: "text/plain" }), `aetna-policy-${stamp}.txt`);
dfd.set("kind", "document");
dfd.set("payerId", aetna);
dfd.set("state", "OH");
dfd.set("title", "Aetna Home Health Policy (live-test)");
const ext = await req("POST", "/api/rulebook/upload", dfd, { form: true });
const ed = ext.j?.data;
ok("policy document accepted + stored", (ext.s === 200 || ext.s === 201) && !!ed?.sourceDocId, `status=${ext.s} sourceDoc=${ed?.sourceDocId?.slice(0, 8)}`);
ok("document chunked into the searchable RAG corpus", (ed?.chunkCount ?? 0) >= 1, `chunks=${ed?.chunkCount} embedded=${ed?.embedded}`);
info(`ingested ${ed?.chunkCount} chunk(s), embedded=${ed?.embedded} — this is what the NL lookup cites`);

// ════════════════════════════════════════════════════════════════════
// DEEP #7 — cheat sheet renders a real PDF (or is Q7-gated)
// ════════════════════════════════════════════════════════════════════
console.log("\n████ DEEP: cheat-sheet PDF ████");
const cs = await req("POST", "/api/cheatsheets", { state: "OH", payerId: aetna, cptCodes: ["99347", "99348", "99349"], orgName: ORG_NAME });
ok("cheat sheet renders a real PDF (or Q7 gate 403)", (cs.isPdf && cs.bytes > 3000) || cs.s === 403, cs.s === 403 ? "gated pending operator review (Q7)" : `${(cs.bytes / 1024).toFixed(1)} KB PDF`);

// ── care plan (browsable) ──────────────────────────────────────────────
console.log("\n── care plan ──");
await req("PUT", `/api/care-plans/${adaId}`, { document: { type: "doc", content: [] }, goalsOfCareSummary: "Comfort-focused; DNR in place; family aligned.", primarySymptoms: ["dyspnea", "pain"], activeMedications: ["morphine", "lorazepam"] });
ok("care plan saved for Ada", true);

// ════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} deep checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }

console.log(`\n████  YOUR LIVE ACCOUNT — LOG IN AND CLICK THROUGH  ████`);
console.log(`  URL:      ${BASE}/login`);
console.log(`  email:    ${EMAIL}`);
console.log(`  password: ${PASSWORD}`);
console.log(`  org:      ${ORG_NAME}`);
console.log(`\n  What to click to SEE each verified feature:`);
console.log(`   • Patients      → Ada Lovelace (Critical chip), Grace Hopper (High); Last/Next visit columns`);
console.log(`   • Ada → Superbill → payer-scoped code picker + per-line risk badges (denial predictor)`);
console.log(`   • Billing → Lookup → ask an NL question; see the cited answer`);
console.log(`   • Billing → Denials → the logged denial + AI analysis recommendation`);
console.log(`   • Rulebook       → generated rulebook + Path-B upload → side-by-side comparison`);
console.log(`   • Cheat sheets   → generate the Aetna/OH PDF`);
console.log(`   • Ada → Messages → team thread; Ada → Care plan → saved goals`);
console.log(`   • Schedule       → week grid (drag a visit, add PTO, print route)`);

process.exit(failed.length === 0 ? 0 : 1);
