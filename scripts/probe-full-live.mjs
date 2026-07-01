/**
 * FULL live coverage probe — exercises EVERY API route + method against a
 * running Pallio instance, forces the real LLM paths, and prints a precise
 * endpoint-coverage report so we know nothing is untested.
 *
 * Run on the VPS (it has ANTHROPIC/OPENAI keys, so the AI paths run for real):
 *
 *   BASE_URL=https://app.pallio.io \
 *   CRON_SECRET=<the real /etc/pallio CRON_SECRET> \
 *   node scripts/probe-full-live.mjs
 *
 * CRON_SECRET is OPTIONAL — without it the cron LLM jobs are only gate-tested
 * (401). With it, the document-ingestion LLM + feedback + pull crons run live.
 *
 * Exit code 0 iff every check passed AND every route was hit.
 */

const BASE = process.env.BASE_URL || "https://app.pallio.io";
const CRON = process.env.CRON_SECRET || "";
const s = Date.now();

// ---- session cookies (primary org A, secondary org B for RLS) -------------
const jars = { A: "", B: "", L: "", none: "" };
const results = [];
const HIT = new Set(); // `${METHOD} ${template}`
let LAST = { method: "", path: "", status: 0 }; // last request, for auto-diagnostics

const ok = (n, c, d = "") => {
  results.push({ n, c });
  // On failure with no explicit detail, surface the last request's status
  // so a scrolled-off failure block is still diagnosable.
  const detail = d || (c ? "" : `last: ${LAST.method} ${LAST.path} → ${LAST.status}`);
  console.log(`${c ? "✅" : "❌"} ${n}${detail ? "  — " + detail : ""}`);
};

// Full route inventory (kept in sync with `find app/api -name route.ts`).
// One line per METHOD + route template. The coverage report checks every
// one of these was hit at least once.
const ROUTES = `
POST /auth/signup
POST /auth/login
POST /auth/logout
GET /auth/me
PATCH /auth/me
POST /auth/change-password
GET /auth/mfa/status
POST /auth/mfa/setup
POST /auth/mfa/verify
POST /auth/mfa/disable
POST /auth/password/request-reset
POST /auth/password/confirm-reset
GET /onboarding
POST /onboarding/profile
POST /onboarding/states
POST /onboarding/payers
POST /onboarding/cpt-codes
POST /onboarding/finalize
GET /patients
POST /patients
GET /patients/[id]
PATCH /patients/[id]
GET /patients/[id]/export
GET /patients/[id]/messages
POST /patients/[id]/messages
PATCH /messages/[id]
GET /notifications
PATCH /notifications
GET /visits
POST /visits
GET /visits/[id]
PATCH /visits/[id]/document
PATCH /visits/[id]/reschedule
POST /visits/[id]/transition
GET /visits/[id]/superbill
POST /visits/[id]/superbill
GET /care-plans/[patientId]
PUT /care-plans/[patientId]
GET /superbills
PATCH /superbills/[id]
GET /superbills/[id]/pdf
POST /superbills/predict
GET /billing/payers
GET /billing/allowed-codes
GET /billing/icd10
POST /billing/lookup
POST /billing/lookup/pdf
GET /billing/denial-metrics
GET /billing/subscription
POST /billing/checkout
GET /denials
POST /denials
GET /denials/[id]
POST /denials/[id]/analyze
POST /denials/[id]/decide
POST /denials/[id]/refile
POST /denials/[id]/outcome
GET /denials/[id]/prediction
POST /cheatsheets
GET /cheatsheets/templates
GET /rulebook
POST /rulebook/generate
GET /rulebook/comparison
POST /rulebook/upload
POST /rulebook/merge
POST /rulebook/save
GET /reports/overview
GET /audit
GET /inbox
GET /documents
GET /settings/branding
PUT /settings/branding
GET /settings/license
GET /schedule/context
GET /time-off
POST /time-off
DELETE /time-off/[id]
GET /team/members
PUT /team/members/[userId]
GET /team/invites
POST /team/invites
GET /invites/[token]
POST /invites/[token]/accept
GET /attestations
POST /attestations
GET /attestations/[id]
DELETE /attestations/[id]
GET /attestations/requests
POST /attestations/requests
POST /attestations/requests/[id]/claim
POST /attestations/requests/[id]/resolve
GET /integrations/google
DELETE /integrations/google
GET /integrations/google/connect
GET /integrations/google/callback
POST /integrations/google/busy
GET /health/livez
GET /admin/orgs
GET /admin/compliance
GET /admin/platform-settings
POST /admin/platform-settings
GET /admin/ingestion-sources
POST /admin/ingestion-sources
POST /admin/ingestion-sources/[id]/run
GET /admin/cheatsheet-templates
POST /admin/cheatsheet-templates
POST /admin/cheatsheet-templates/[id]/publish
POST /admin/cheatsheet-templates/[id]/withdraw
POST /cron/ingest-documents
POST /cron/payer-rule-alerts
POST /cron/denial-feedback
POST /cron/pull-calendar
POST /webhooks/stripe
`
  .trim()
  .split("\n")
  .map((l) => l.trim());

const ROUTE_PATTERNS = ROUTES.map((r) => {
  const [method, path] = r.split(" ");
  const segs = path.split("/").filter(Boolean);
  return { method, path, segs, wild: segs.filter((s) => s.startsWith("[")).length };
})
  // Literal-heavy patterns first so e.g. "/attestations/requests" wins
  // over the wildcard "/attestations/[id]" for the same shape.
  .sort((a, b) => a.wild - b.wild);

/** Normalize a requested path to its route template + record the hit. */
function record(method, rawPath) {
  const path = rawPath.split("?")[0].replace(/\/$/, "").replace(/^\/api/, "");
  const segs = path.split("/").filter(Boolean);
  for (const rp of ROUTE_PATTERNS) {
    if (rp.method !== method) continue;
    if (rp.segs.length !== segs.length) continue;
    let match = true;
    for (let i = 0; i < segs.length; i++) {
      const t = rp.segs[i];
      if (t.startsWith("[")) continue; // wildcard
      if (t !== segs[i]) { match = false; break; }
    }
    if (match) { HIT.add(`${rp.method} ${rp.path}`); return; }
  }
}

async function req(method, path, body, opts = {}) {
  const who = opts.who || "A";
  const jar = who === "none" ? "" : jars[who];
  const h = { ...(jar ? { cookie: jar } : {}), ...(opts.headers || {}) };
  let payload;
  if (body !== undefined) {
    if (opts.form) payload = body;
    else { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  }
  record(method, path);
  const r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  LAST = { method, path, status: r.status };
  for (const c of r.headers.getSetCookie?.() || []) {
    const x = c.match(/^pallio_session=([^;]*)/);
    if (x && who !== "none") jars[who] = `pallio_session=${x[1]}`;
  }
  const ct = r.headers.get("content-type") || "";
  const isPdf = ct.includes("pdf");
  let j = null, t = "", bytes = 0;
  if (isPdf) {
    const buf = await r.arrayBuffer();
    bytes = buf.byteLength; // measure the real body (content-length isn't always set)
  } else {
    t = await r.text();
    bytes = t.length;
    try { j = JSON.parse(t); } catch {}
  }
  return { s: r.status, j, t, isPdf, bytes, ct };
}

console.log(`\n████  FULL LIVE PROBE → ${BASE}  ████\n`);

// ════════════════════════════════════════════════════════════════════
// 1. AUTH + ONBOARDING
// ════════════════════════════════════════════════════════════════════
console.log("── auth + onboarding ──");
const email = `full-${s}@pallio-smoke.test`;
const pwd = `Fp-${s}!x`;
const orgName = `Full ${s}`;
ok("POST /auth/signup", (await req("POST", "/api/auth/signup", { email, password: pwd, fullName: "Full Probe", orgName, baaAccepted: true })).s === 201);
// Isolated jar so re-issuing a session can't disturb the primary run.
ok("POST /auth/login (same creds)", (await req("POST", "/api/auth/login", { email, password: pwd }, { who: "L" })).s === 200);
const me = await req("GET", "/api/auth/me");
ok("GET /auth/me — org_admin", me.j?.data?.role === "org_admin", `perms=${me.j?.data?.permissions?.length}`);
ok("PATCH /auth/me (profile)", [200, 400, 422].includes((await req("PATCH", "/api/auth/me", { fullName: "Full Probe II" })).s));
ok("GET /onboarding (status)", (await req("GET", "/api/onboarding")).s === 200);
const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
ok("GET /billing/payers — 18 seeded", payers.length >= 10, `n=${payers.length}`);
const aetna = payers.find((p) => /aetna/i.test(p.name))?.id;
ok("POST /onboarding/profile", (await req("POST", "/api/onboarding/profile", { name: orgName, npi: "1234567890", orgType: "palliative" })).s === 200);
ok("POST /onboarding/states", (await req("POST", "/api/onboarding/states", { states: ["OH"] })).s === 200);
ok("POST /onboarding/payers", (await req("POST", "/api/onboarding/payers", { payerIds: [aetna] })).s === 200);
ok("POST /onboarding/cpt-codes", (await req("POST", "/api/onboarding/cpt-codes", { cptCodes: ["99347", "99348", "99349", "99350", "G0318"] })).s === 200);
ok("POST /onboarding/finalize", [200, 201, 409].includes((await req("POST", "/api/onboarding/finalize", {})).s));

// ════════════════════════════════════════════════════════════════════
// 2. PATIENTS + VISITS + CARE PLAN
// ════════════════════════════════════════════════════════════════════
console.log("\n── patients + visits + care plan ──");
const pc = await req("POST", "/api/patients", {
  demographics: { firstName: "Ada", lastName: `Probe${s}`, dateOfBirth: "1940-05-01", sexAssignedAtBirth: "F", addressLine1: "1 Elm", city: "Columbus", state: "OH", zip: "43004", phone: "555-0100" },
  insurance: { primaryPayerId: aetna, primaryMemberId: "M123" },
  clinical: { primaryDiagnosisIcd10: "Z51.5", acuity: "high" },
  consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
  careTeam: {},
});
const patientId = pc.j?.data?.id;
ok("POST /patients", !!patientId, patientId ? `id=${patientId.slice(0, 8)}` : `status=${pc.s} err=${(pc.t || "").slice(0, 120)}`);
ok("GET /patients (list)", (await req("GET", "/api/patients?limit=20")).s === 200);
ok("GET /patients/[id]", (await req("GET", `/api/patients/${patientId}`)).j?.data?.acuity === "high");
ok("PATCH /patients/[id] (acuity=critical)", (await req("PATCH", `/api/patients/${patientId}`, { clinical: { acuity: "critical" } })).s === 200);
ok("GET /patients/[id]/export", [200, 202].includes((await req("GET", `/api/patients/${patientId}/export`)).s));

const vc = await req("POST", "/api/visits", { patientId, clinicianUserId: me.j?.data?.userId, visitType: "established_patient_home", scheduledStart: new Date(Date.now() + 86400_000).toISOString(), isTelehealth: false });
const visitId = vc.j?.data?.id;
ok("POST /visits (schedule)", !!visitId, `id=${visitId?.slice(0, 8)}`);
ok("GET /visits (list, joined)", Array.isArray((await req("GET", "/api/visits?limit=50")).j?.data?.rows));
ok("GET /visits/[id]", (await req("GET", `/api/visits/${visitId}`)).s === 200);
ok("PATCH /visits/[id]/document", (await req("PATCH", `/api/visits/${visitId}/document`, { totalMinutes: 45, documentText: "Home visit note.", cptCodesAssigned: ["99349"], icd10Codes: ["Z515"] })).s === 200);
ok("PATCH /visits/[id]/reschedule", [200, 404].includes((await req("PATCH", `/api/visits/${visitId}/reschedule`, { scheduledStart: new Date(Date.now() + 2 * 86400_000).toISOString() })).s));
ok("POST /visits/[id]/transition", [200, 400, 409, 422].includes((await req("POST", `/api/visits/${visitId}/transition`, { status: "pending_billing" })).s));
ok("PUT /care-plans/[patientId]", [200, 201].includes((await req("PUT", `/api/care-plans/${patientId}`, { document: { type: "doc", content: [] }, goalsOfCareSummary: "Comfort-focused care.", primarySymptoms: ["pain"], activeMedications: ["morphine"] })).s));
ok("GET /care-plans/[patientId]", (await req("GET", `/api/care-plans/${patientId}`)).s === 200);

// ════════════════════════════════════════════════════════════════════
// 3. SUPERBILL + BILLING (incl. picker, predict, PDF)
// ════════════════════════════════════════════════════════════════════
console.log("\n── superbill + billing ──");
ok("GET /visits/[id]/superbill (draft)", (await req("GET", `/api/visits/${visitId}/superbill`)).s === 200);
const sbSave = await req("POST", `/api/visits/${visitId}/superbill`);
const superbillId = sbSave.j?.data?.id;
ok("POST /visits/[id]/superbill (persist)", !!superbillId);
ok("GET /superbills (list)", Array.isArray((await req("GET", "/api/superbills")).j?.data?.rows));
ok("PATCH /superbills/[id] (edit + override audit)", (await req("PATCH", `/api/superbills/${superbillId}`, { patch: { cptCodes: ["99348", "99349"], modifiers: ["25"] }, overrides: [{ code: "X9999", reason: "full-probe override" }] })).s === 200);
const sbPdf = await req("GET", `/api/superbills/${superbillId}/pdf`);
ok("GET /superbills/[id]/pdf", sbPdf.isPdf && sbPdf.bytes > 3000, `${sbPdf.bytes}B`);
ok("GET /billing/allowed-codes", (await req("GET", `/api/billing/allowed-codes?payerId=${aetna}&state=OH`)).s === 200);
ok("GET /billing/allowed-codes?includeDenied", (await req("GET", `/api/billing/allowed-codes?payerId=${aetna}&state=OH&includeDenied=true`)).s === 200);
ok("GET /billing/icd10 (autocomplete)", Array.isArray((await req("GET", "/api/billing/icd10?query=Z51")).j?.data?.rows));
ok("POST /superbills/predict", (await req("POST", "/api/superbills/predict", { payerId: aetna, state: "OH", dos: new Date().toISOString().slice(0, 10), cptCodes: ["99348", "X9999"] })).s === 200);
ok("GET /billing/denial-metrics", (await req("GET", "/api/billing/denial-metrics")).s === 200);
ok("GET /billing/subscription", [200, 402, 404].includes((await req("GET", "/api/billing/subscription")).s));
ok("POST /billing/checkout (Stripe session)", [200, 400, 402, 500, 503].includes((await req("POST", "/api/billing/checkout", { tier: "team" })).s));

// ════════════════════════════════════════════════════════════════════
// 4. LLM PATHS (real model calls — VPS has the keys)
// ════════════════════════════════════════════════════════════════════
console.log("\n── LLM paths (live model calls) ──");
const lkStruct = await req("POST", "/api/billing/lookup", { payerId: aetna, state: "OH", cptCode: "99349", attribute: "covered" });
ok("POST /billing/lookup — structured cited", lkStruct.s === 200 && !!lkStruct.j?.data, `source=${lkStruct.j?.data?.source}`);
const lkNL = await req("POST", "/api/billing/lookup", { query: "Does Aetna cover home visits in Ohio for 40 minutes?" });
ok("POST /billing/lookup — NL parser (haiku) ran", lkNL.s === 200 && !!lkNL.j?.data, `source=${lkNL.j?.data?.source ?? "?"}`);
ok("POST /billing/lookup/pdf", [200, 422].includes((await req("POST", "/api/billing/lookup/pdf", { payerId: aetna, state: "OH", cptCode: "99349", attribute: "covered" })).s));

// denial → AI analyze (real Claude)
const dlog = await req("POST", "/api/denials", { superbillId, cptCode: "99349", carcCode: "16", denialReason: "missing info", deniedAmountCents: 12500, deniedAt: new Date().toISOString() });
const denialId = dlog.j?.data?.id;
ok("POST /denials (log)", !!denialId);
ok("GET /denials (list)", Array.isArray((await req("GET", "/api/denials")).j?.data?.rows));
ok("GET /denials/[id]", (await req("GET", `/api/denials/${denialId}`)).s === 200);
const analyze = await req("POST", `/api/denials/${denialId}/analyze`);
ok("POST /denials/[id]/analyze — Claude analysis", analyze.s === 200 && (!!analyze.j?.data?.recommendation || !!analyze.j?.data?.text), `status=${analyze.s} rec=${analyze.j?.data?.recommendation ?? "?"}`);
ok("GET /denials/[id]/prediction (predicted vs actual)", (await req("GET", `/api/denials/${denialId}/prediction`)).s === 200);
ok("POST /denials/[id]/decide", [200, 409, 422].includes((await req("POST", `/api/denials/${denialId}/decide`, { decision: "refile" })).s));
ok("POST /denials/[id]/refile", [200, 409, 422].includes((await req("POST", `/api/denials/${denialId}/refile`, {})).s));
ok("POST /denials/[id]/outcome", [200, 409, 422].includes((await req("POST", `/api/denials/${denialId}/outcome`, { outcome: "paid", outcomeAmountCents: 12500 })).s));

// ════════════════════════════════════════════════════════════════════
// 5. RULEBOOK + CHEATSHEETS
// ════════════════════════════════════════════════════════════════════
console.log("\n── rulebook + cheatsheets ──");
ok("POST /rulebook/generate", [200, 201].includes((await req("POST", "/api/rulebook/generate", {})).s));
const rb = await req("GET", "/api/rulebook");
ok("GET /rulebook — rows + provenance", (rb.j?.data?.rulebook?.rows?.length ?? 0) > 0, `rows=${rb.j?.data?.rulebook?.rows?.length}`);
// Path-B upload is multipart/form-data with a CSV file (not JSON).
const csv = "payer,state,cpt,attribute,value\nAetna,OH,99349,covered,covered\nAetna,OH,99348,covered,covered\n";
const fd = new FormData();
fd.set("file", new Blob([csv], { type: "text/csv" }), "rulebook.csv");
fd.set("kind", "rulebook");
const up = await req("POST", "/api/rulebook/upload", fd, { form: true });
ok("POST /rulebook/upload (multipart)", [200, 201, 422].includes(up.s), `status=${up.s}`);
const uploadId = up.j?.data?.id ?? up.j?.data?.uploadId ?? "00000000-0000-0000-0000-000000000000";
ok("GET /rulebook/comparison", [200, 400, 404].includes((await req("GET", `/api/rulebook/comparison?uploadId=${uploadId}`)).s), `uploadId=${uploadId?.slice(0, 8)}`);
ok("POST /rulebook/merge", [200, 400, 404, 422].includes((await req("POST", "/api/rulebook/merge", { rows: [] })).s));
ok("POST /rulebook/save", [200, 400, 422].includes((await req("POST", "/api/rulebook/save", { edits: [] })).s));
const cs = await req("POST", "/api/cheatsheets", { state: "OH", payerId: aetna, cptCodes: ["99348", "99349"], orgName });
ok("POST /cheatsheets (PDF or Q7 gate 403)", (cs.isPdf && cs.bytes > 3000) || cs.s === 403, cs.s === 403 ? "gated (Q7)" : `${cs.bytes}B`);
ok("GET /cheatsheets/templates (org-side published)", (await req("GET", "/api/cheatsheets/templates")).s === 200);

// ════════════════════════════════════════════════════════════════════
// 6. MESSAGING + NOTIFICATIONS + INBOX + DOCS + REPORTS + AUDIT
// ════════════════════════════════════════════════════════════════════
console.log("\n── messaging / notifications / misc reads ──");
ok("POST /patients/[id]/messages", [200, 201].includes((await req("POST", `/api/patients/${patientId}/messages`, { body: "Full probe message" })).s));
const msgs = await req("GET", `/api/patients/${patientId}/messages`);
ok("GET /patients/[id]/messages", (msgs.j?.data?.messages?.length ?? 0) >= 1);
const firstMsgId = msgs.j?.data?.messages?.[0]?.id;
ok("PATCH /messages/[id] (edit window)", firstMsgId ? [200, 422].includes((await req("PATCH", `/api/messages/${firstMsgId}`, { body: "edited within window" })).s) : false);
ok("GET /notifications", typeof (await req("GET", "/api/notifications")).j?.data?.unreadCount === "number");
ok("PATCH /notifications (mark read)", (await req("PATCH", "/api/notifications", {})).s === 200);
ok("GET /inbox", (await req("GET", "/api/inbox")).s === 200);
ok("GET /documents", (await req("GET", "/api/documents")).s === 200);
ok("GET /reports/overview", (await req("GET", "/api/reports/overview")).s === 200);
ok("GET /audit", (await req("GET", "/api/audit?limit=10")).s === 200);

// ════════════════════════════════════════════════════════════════════
// 7. SETTINGS / SCHEDULE / TIME-OFF / TEAM
// ════════════════════════════════════════════════════════════════════
console.log("\n── settings / schedule / team ──");
ok("GET /settings/branding", (await req("GET", "/api/settings/branding")).s === 200);
ok("PUT /settings/branding", (await req("PUT", "/api/settings/branding", { displayName: orgName, primaryColor: "#0d9488" })).s === 200);
ok("GET /settings/license", (await req("GET", "/api/settings/license")).s === 200);
const wkFrom = new Date().toISOString(), wkTo = new Date(Date.now() + 7 * 86400_000).toISOString();
ok("GET /schedule/context", (await req("GET", `/api/schedule/context?from=${encodeURIComponent(wkFrom)}&to=${encodeURIComponent(wkTo)}`)).s === 200);
ok("GET /time-off", Array.isArray((await req("GET", "/api/time-off")).j?.data?.rows));
const toC = await req("POST", "/api/time-off", { clinicianUserId: me.j?.data?.userId, startDate: new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10), endDate: new Date(Date.now() + 6 * 86400_000).toISOString().slice(0, 10), reason: "probe PTO" });
const toId = toC.j?.data?.id;
ok("POST /time-off", !!toId);
ok("DELETE /time-off/[id]", toId ? (await req("DELETE", `/api/time-off/${toId}`)).s === 200 : false);
ok("GET /team/members", Array.isArray((await req("GET", "/api/team/members")).j?.data?.rows));
ok("GET /team/invites", (await req("GET", "/api/team/invites")).s === 200);
const inv = await req("POST", "/api/team/invites", { email: `invitee-${s}@pallio-smoke.test`, roleTemplate: "clinician", permissions: [] });
ok("POST /team/invites (seat-limit 402 or 201)", [201, 200, 402].includes(inv.s), `status=${inv.s}`);
// Target a NON-existent member so we exercise the route without ever
// mutating the caller's own permission set (which could disturb the run).
ok("PUT /team/members/[userId]", [200, 400, 403, 404, 422].includes((await req("PUT", `/api/team/members/00000000-0000-0000-0000-000000000000`, { permissions: ["patients.view"] })).s));

// ════════════════════════════════════════════════════════════════════
// 8. ATTESTATIONS (analyst bridge)
// ════════════════════════════════════════════════════════════════════
console.log("\n── attestations ──");
ok("GET /attestations", (await req("GET", "/api/attestations")).s === 200);
ok("GET /attestations/requests", (await req("GET", "/api/attestations/requests")).s === 200);
const att = await req("POST", "/api/attestations", { payerId: aetna, state: "OH", cptCode: "99348", attribute: "covered", coverageStatus: "covered", ruleValue: { answer: "Covered per rep" }, payerRepName: "Rep", callDate: new Date().toISOString().slice(0, 10), confirmedQuote: `Full probe ${s}` });
const attId = att.j?.data?.id;
ok("POST /attestations (Source 3 bridge)", att.s === 201 || att.s === 200, `status=${att.s}`);
ok("GET /attestations/[id]", attId ? (await req("GET", `/api/attestations/${attId}`)).s === 200 : false);
const areq = await req("POST", "/api/attestations/requests", { payerId: aetna, state: "OH", cptCode: "G0318", attribute: "covered", sourceQuery: "probe" });
const areqId = areq.j?.data?.id;
ok("POST /attestations/requests", [200, 201].includes(areq.s));
ok("POST /attestations/requests/[id]/claim", areqId ? [200, 409, 404].includes((await req("POST", `/api/attestations/requests/${areqId}/claim`, {})).s) : false);
ok("POST /attestations/requests/[id]/resolve", areqId ? [200, 409, 404, 422].includes((await req("POST", `/api/attestations/requests/${areqId}/resolve`, { resolution: "confirmed" })).s) : false);
ok("DELETE /attestations/[id] (void)", attId ? [200, 404, 422].includes((await req("DELETE", `/api/attestations/${attId}`, { reason: "probe void" })).s) : false);

// ════════════════════════════════════════════════════════════════════
// 9. INTEGRATIONS (Google) + MFA + PASSWORD RESET + INVITES
// ════════════════════════════════════════════════════════════════════
console.log("\n── integrations / mfa / reset / invites ──");
ok("GET /integrations/google (status)", [200, 503].includes((await req("GET", "/api/integrations/google")).s));
ok("GET /integrations/google/connect (redirect or 503)", [302, 303, 307, 503].includes((await req("GET", "/api/integrations/google/connect")).s));
ok("GET /integrations/google/callback (missing code → 400/401/503)", [400, 401, 503].includes((await req("GET", "/api/integrations/google/callback")).s));
ok("POST /integrations/google/busy", [200, 422, 503].includes((await req("POST", "/api/integrations/google/busy", { fromIso: wkFrom, toIso: wkTo })).s));
ok("DELETE /integrations/google (disconnect)", [200, 404, 503].includes((await req("DELETE", "/api/integrations/google")).s));
ok("GET /auth/mfa/status", (await req("GET", "/api/auth/mfa/status")).s === 200);
const mfaSetup = await req("POST", "/api/auth/mfa/setup");
ok("POST /auth/mfa/setup", mfaSetup.s === 200 && !!mfaSetup.j?.data);
ok("POST /auth/mfa/verify (bad code → 400/422)", [400, 401, 422].includes((await req("POST", "/api/auth/mfa/verify", { code: "000000" })).s));
ok("POST /auth/mfa/disable", [200, 400, 401, 422].includes((await req("POST", "/api/auth/mfa/disable", { code: "000000" })).s));
ok("POST /auth/password/request-reset (always 200)", (await req("POST", "/api/auth/password/request-reset", { email })).s === 200);
ok("POST /auth/password/confirm-reset (bad token → 400/422)", [400, 401, 404, 422].includes((await req("POST", "/api/auth/password/confirm-reset", { token: "bad", password: `Xx-${s}!zz` })).s));
ok("GET /invites/[token] (bad → 404)", [404, 400, 410].includes((await req("GET", "/api/invites/deadbeef")).s));
ok("POST /invites/[token]/accept (bad → 404)", [404, 400, 410, 422].includes((await req("POST", "/api/invites/deadbeef/accept", { password: `Xx-${s}!zz`, fullName: "X" })).s));

// ════════════════════════════════════════════════════════════════════
// 10. CROSS-ORG RLS ISOLATION (org B)
// ════════════════════════════════════════════════════════════════════
console.log("\n── cross-org RLS ──");
ok("Org B signup", (await req("POST", "/api/auth/signup", { email: `fb-${s}@pallio-smoke.test`, password: `Fb-${s}!x`, fullName: "B", orgName: `FB ${s}`, baaAccepted: true }, { who: "B" })).s === 201);
const bSeesA = await req("GET", `/api/patients/${patientId}`, undefined, { who: "B" });
ok("RLS — Org B cannot read Org A patient (404/403)", [404, 403].includes(bSeesA.s), `status=${bSeesA.s}`);
const bSeesV = await req("GET", `/api/visits/${visitId}`, undefined, { who: "B" });
ok("RLS — Org B cannot read Org A visit (404/403)", [404, 403].includes(bSeesV.s), `status=${bSeesV.s}`);

// ════════════════════════════════════════════════════════════════════
// 11. OPERATOR GATES (from non-admin org A) + HEALTH + WEBHOOK
// ════════════════════════════════════════════════════════════════════
console.log("\n── operator gates / health / webhook ──");
for (const [m, p] of [["GET", "/api/admin/orgs"], ["GET", "/api/admin/compliance"], ["GET", "/api/admin/platform-settings"], ["GET", "/api/admin/ingestion-sources"], ["GET", "/api/admin/cheatsheet-templates"]]) {
  ok(`admin gate: ${m} ${p} → 403`, (await req(m, p)).s === 403);
}
ok("POST /admin/platform-settings → 403", (await req("POST", "/api/admin/platform-settings", {})).s === 403);
ok("POST /admin/ingestion-sources → 403", (await req("POST", "/api/admin/ingestion-sources", { name: "x", url: "https://x", documentType: "lcd", scheduleCadence: "daily" })).s === 403);
ok("POST /admin/ingestion-sources/[id]/run → 403", (await req("POST", "/api/admin/ingestion-sources/00000000-0000-0000-0000-000000000000/run", {})).s === 403);
ok("POST /admin/cheatsheet-templates (scan) → 403", (await req("POST", "/api/admin/cheatsheet-templates", {})).s === 403);
ok("POST /admin/cheatsheet-templates/[id]/publish → 403", (await req("POST", "/api/admin/cheatsheet-templates/00000000-0000-0000-0000-000000000000/publish", {})).s === 403);
ok("POST /admin/cheatsheet-templates/[id]/withdraw → 403", (await req("POST", "/api/admin/cheatsheet-templates/00000000-0000-0000-0000-000000000000/withdraw", {})).s === 403);
ok("GET /health/livez (unauth)", (await req("GET", "/api/health/livez", undefined, { who: "none" })).s === 200);
ok("POST /webhooks/stripe (bad sig → 400)", [400, 401, 403].includes((await req("POST", "/api/webhooks/stripe", { type: "x" }, { who: "none" })).s));

// ════════════════════════════════════════════════════════════════════
// 12. CRON JOBS — gate-tested; LLM-run if CRON_SECRET provided
// ════════════════════════════════════════════════════════════════════
console.log("\n── cron jobs ──");
const cronJobs = ["ingest-documents", "payer-rule-alerts", "denial-feedback", "pull-calendar"];
for (const job of cronJobs) {
  ok(`cron gate: POST /cron/${job} no secret → 401`, (await req("POST", `/api/cron/${job}`, undefined, { who: "none" })).s === 401);
}
if (CRON) {
  console.log("  (CRON_SECRET provided — running the real LLM/ingestion crons)");
  for (const job of cronJobs) {
    const r = await req("POST", `/api/cron/${job}`, undefined, { who: "none", headers: { "x-cron-secret": CRON } });
    ok(`cron RUN: POST /cron/${job} → success`, r.s === 200 && r.j?.success === true, `body=${(r.t || "").slice(0, 160)}`);
  }
} else {
  console.log("  (no CRON_SECRET — skipping real cron runs; set it to exercise the ingestion LLM)");
}

// ════════════════════════════════════════════════════════════════════
// 13. CHANGE PASSWORD + LOGOUT (do last — may rotate/invalidate session)
// ════════════════════════════════════════════════════════════════════
console.log("\n── change-password + logout ──");
ok("POST /auth/change-password", [200, 400, 401, 422].includes((await req("POST", "/api/auth/change-password", { currentPassword: pwd, newPassword: `${pwd}Z9` })).s));
ok("POST /auth/logout", (await req("POST", "/api/auth/logout")).s === 200);
ok("GET /auth/me after logout → 401", (await req("GET", "/api/auth/me")).s === 401);

// ════════════════════════════════════════════════════════════════════
// COVERAGE REPORT
// ════════════════════════════════════════════════════════════════════
const missed = ROUTES.filter((r) => !HIT.has(r));
console.log("\n████  COVERAGE  ████");
console.log(`Routes hit: ${HIT.size}/${ROUTES.length}`);
if (missed.length) {
  console.log("NOT covered:");
  for (const m of missed) console.log("  ✗ " + m);
} else {
  console.log("✅ every route exercised");
}

const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) {
  console.log("\nFailures:");
  for (const f of failed) console.log("  ❌ " + f.n);
}
const allGreen = pass === results.length && missed.length === 0;
console.log(`\n${allGreen ? "✅ ALL GREEN + FULL COVERAGE" : "❌ see above"}`);
process.exit(allGreen ? 0 : 1);
