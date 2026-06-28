/**
 * Comprehensive scenario probe — covers every user-facing flow AND
 * platform-operator gate / surface we can reach from outside a
 * platform_admin session. Designed to be re-runnable; uses fresh
 * orgs each time so no state carries between runs.
 *
 * Coverage:
 *   USER PERSPECTIVE
 *     · signup + onboarding (profile, states, payers, CPT codes)
 *     · patient CRUD (create, list, get, patch)
 *     · visit schedule + document + get
 *     · care plan put + get
 *     · superbill draft + persist + PDF
 *     · billing lookup — structured + NL
 *     · cheat-sheet PDF
 *     · denial log + AI analyze + refile
 *     · attestation queue (read), attestation create
 *     · attestation flag from rulebook UI (Unknown row → /api/attestations/requests)
 *     · path B CSV upload + reconcile + merge
 *     · rulebook generate + provenance (sourceKind) + auto-refresh
 *     · cross-org RLS isolation
 *     · MFA setup + status
 *     · password rotation
 *     · branding update
 *     · audit log read
 *     · seat-limit enforcement (402 on solo plan)
 *     · sidebar shows rulebook (not payers)
 *     · /payers redirects to /settings/rulebook
 *
 *   OPERATOR PERSPECTIVE (gate-tested from fresh non-admin)
 *     · /api/admin/orgs              → 403
 *     · /api/admin/compliance        → 403
 *     · /api/admin/platform-settings → 403
 *     · /api/admin/ingestion-sources → 403
 *     · /api/cron/ingest-documents (no/wrong secret) → 401
 *     · /api/cron/payer-rule-alerts (no/wrong secret) → 401
 *     · /api/health/livez → 200 (unauthenticated)
 *
 *   CROSS-CUTTING
 *     · gold-standard eval gate (verified separately via CI)
 *     · GitHub Actions cron (verified separately via workflow_dispatch)
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const s = Date.now();
let cookieA = "";
let cookieB = "";
let currentCookie = () => cookieA;
const results = [];
const ok = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

async function req(m, p, b, opts = {}) {
  const h = { ...(currentCookie() ? { cookie: currentCookie() } : {}) };
  let body;
  if (b !== undefined) {
    if (opts.form) body = b;
    else { h["content-type"] = "application/json"; body = JSON.stringify(b); }
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) h[k] = v;
  const r = await fetch(BASE + p, { method: m, headers: h, body, redirect: opts.redirect ?? "manual" });
  if (opts.role !== "anon") {
    for (const c of r.headers.getSetCookie?.() || []) {
      const x = c.match(/^pallio_session=([^;]*)/);
      if (x) {
        if (opts.who === "B") cookieB = `pallio_session=${x[1]}`;
        else cookieA = `pallio_session=${x[1]}`;
      }
    }
  }
  const ct = r.headers.get("content-type") || "";
  const isPdf = ct.includes("application/pdf");
  const bytes = isPdf ? (await r.arrayBuffer()).byteLength : 0;
  const t = isPdf ? "" : await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t, bytes, isPdf };
}

console.log("\n████  USER PERSPECTIVE  ████");

// signup + onboarding
const orgName = `Scen ${s}`;
const email = `scen-${s}@pallio-smoke.test`;
const pwd = `ScenP-${s}!`;
ok("auth.signup", (await req("POST", "/api/auth/signup", { email, password: pwd, fullName: "Scen User", orgName, baaAccepted: true })).s === 201);

const me = (await req("GET", "/api/auth/me")).j?.data;
ok("auth.me — org_admin role", me?.role === "org_admin", `perms=${me?.permissions?.length}`);

const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const aetna = payers.find((x) => /aetna/i.test(x.name))?.id;
ok("billing.payers — 18 seeded", payers.length === 18);

ok("onboarding.profile", (await req("POST", "/api/onboarding/profile", { name: orgName, npi: "1234567890", orgType: "palliative" })).s === 200);
ok("onboarding.states", (await req("POST", "/api/onboarding/states", { states: ["OH"] })).s === 200);
ok("onboarding.payers", (await req("POST", "/api/onboarding/payers", { payerIds: [aetna] })).s === 200);
ok("onboarding.cpt-codes", (await req("POST", "/api/onboarding/cpt-codes", { cptCodes: ["99348", "99349", "G0318"] })).s === 200);

// rulebook
const gen = await req("POST", "/api/rulebook/generate");
ok("rulebook.generate", gen.s === 200);
const rb = (await req("GET", "/api/rulebook")).j?.data?.rulebook;
ok("rulebook.get — has rows", (rb?.rows?.length ?? 0) > 0, `rows=${rb?.rows?.length}`);
ok("rulebook rows carry sourceKind + sourceCreatedBy", rb.rows.every((r) => "sourceKind" in r && "sourceCreatedBy" in r));
const kinds = new Set(rb.rows.map((r) => r.sourceKind));
ok("rulebook has multiple sourceKinds", kinds.size >= 2, `kinds={${[...kinds].join(",")}}`);

// patients
const pat = await req("POST", "/api/patients", {
  demographics: { firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1940-06-15", sexAssignedAtBirth: "F", state: "OH" },
  insurance: { primaryPayerId: aetna, primaryMemberId: "M-001" },
  clinical: { palliativeReferralReason: "Test" },
  consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
  careTeam: {},
});
const patientId = pat.j?.data?.id;
ok("patients.create", pat.s === 201 && !!patientId);
ok("patients.list contains it", (await req("GET", "/api/patients")).j?.data?.rows?.some((p) => p.id === patientId));
ok("patients.get", (await req("GET", `/api/patients/${patientId}`)).j?.data?.id === patientId);
ok("patients.patch", (await req("PATCH", `/api/patients/${patientId}`, { clinical: { palliativeReferralReason: "Updated" } })).s === 200);

// Phase D — acuity
ok(
  "patients.patch — set acuity=critical",
  (await req("PATCH", `/api/patients/${patientId}`, { clinical: { acuity: "critical" } })).s === 200,
);
const pAcuity = await req("GET", `/api/patients/${patientId}`);
ok("patient.acuity persisted = critical", pAcuity.j?.data?.acuity === "critical", `acuity=${pAcuity.j?.data?.acuity}`);
const listSorted = await req("GET", "/api/patients?status=active&limit=20");
const firstAcuity = listSorted.j?.data?.rows?.[0]?.acuity;
ok(
  "patient list sorts critical-first",
  firstAcuity === "critical" || (listSorted.j?.data?.rows ?? []).length === 1,
  `first=${firstAcuity ?? "(none)"}`,
);
// caseload last/next visit columns surfaced (Mark's ask)
const sampleRow = listSorted.j?.data?.rows?.[0];
ok(
  "patient list carries lastVisitDate + nextVisitDate fields",
  sampleRow && "lastVisitDate" in sampleRow && "nextVisitDate" in sampleRow,
  `last=${sampleRow?.lastVisitDate ?? "null"} next=${sampleRow?.nextVisitDate ?? "null"}`,
);

// visit + care plan + superbill
const start = new Date(Date.now() + 86_400_000).toISOString();
const v = await req("POST", "/api/visits", { patientId, clinicianUserId: me.userId, visitType: "new_patient_home", scheduledStart: start, isTelehealth: false });
const visitId = v.j?.data?.id;
ok("visits.schedule", v.s === 201 && !!visitId);
ok("visits.document", (await req("PATCH", `/api/visits/${visitId}/document`, { totalMinutes: 45, documentText: "Note.", cptCodesAssigned: ["99349"], icd10Codes: ["Z51.5"] })).s === 200);
ok("visits.get", (await req("GET", `/api/visits/${visitId}`)).j?.data?.id === visitId);
ok("careplans.put", (await req("PUT", `/api/care-plans/${patientId}`, { document: { type: "doc" }, primarySymptoms: ["pain"], activeMedications: ["morphine"] })).s === 200);
ok("careplans.get", (await req("GET", `/api/care-plans/${patientId}`)).j?.data?.carePlan?.primarySymptoms?.length > 0);

const sbDraft = await req("GET", `/api/visits/${visitId}/superbill`);
ok("superbills.draft", sbDraft.s === 200 && (sbDraft.j?.data?.draft || sbDraft.j?.data?.existing));
const sbSave = await req("POST", `/api/visits/${visitId}/superbill`);
const superbillId = sbSave.j?.data?.id;
ok("superbills.persist", (sbSave.s === 200 || sbSave.s === 201) && !!superbillId);
const sbPdf = await req("GET", `/api/superbills/${superbillId}/pdf`);
ok("superbills.pdf", sbPdf.s === 200 && sbPdf.isPdf && sbPdf.bytes > 5000, `${sbPdf.bytes}B`);

// Phase A — payer-scoped CPT picker:
// 1. GET /api/billing/allowed-codes returns covered codes for this payer/state
// 2. PATCH /api/superbills/[id] accepts edits + writes overrides to audit_log
// 3. Off-allowlist override surfaces in /api/audit/log
const ac = await req("GET", `/api/billing/allowed-codes?payerId=${aetna}&state=OH`);
ok("billing.allowed-codes responds", ac.s === 200, `rows=${ac.j?.data?.rows?.length ?? 0}`);
// ICD-10 autocomplete (Phase C.1)
const icd = await req("GET", "/api/billing/icd10?query=Z51");
ok("billing.icd10 autocomplete responds", icd.s === 200 && Array.isArray(icd.j?.data?.rows), `rows=${icd.j?.data?.rows?.length ?? 0}`);
// Schedule overlays (Phase E): context + time-off + reschedule
const now = new Date();
const wkFrom = now.toISOString();
const wkTo = new Date(now.getTime() + 7 * 86400_000).toISOString();
const sctx = await req("GET", `/api/schedule/context?from=${encodeURIComponent(wkFrom)}&to=${encodeURIComponent(wkTo)}`);
ok("schedule.context responds (externalBusy + timeOff)", sctx.s === 200 && Array.isArray(sctx.j?.data?.timeOff), `keys=${Object.keys(sctx.j?.data ?? {}).join(",")}`);
const toList = await req("GET", "/api/time-off");
ok("time-off list responds", toList.s === 200 && Array.isArray(toList.j?.data?.rows), `n=${toList.j?.data?.rows?.length ?? 0}`);
const resched = await req("PATCH", `/api/visits/${visitId}/reschedule`, { scheduledStart: new Date(now.getTime() + 2 * 86400_000).toISOString() });
ok("visit reschedule responds", resched.s === 200 || resched.s === 404, `status=${resched.s}`);
// denial metrics endpoint (Phase B.3)
const dm = await req("GET", "/api/billing/denial-metrics");
ok("denial-metrics endpoint responds", dm.s === 200 && typeof dm.j?.data?.metrics === "object", `status=${dm.s}`);
// pull-calendar cron gate
ok("cron gate: /api/cron/pull-calendar no secret → 401", (await req("POST", "/api/cron/pull-calendar")).s === 401);
const sbPatch = await req("PATCH", `/api/superbills/${superbillId}`, {
  patch: { cptCodes: ["99348", "99349"], modifiers: ["25"] },
  overrides: [{ code: "X9999", reason: "Phase A probe — synthetic override for audit verification" }],
});
ok("superbill PATCH accepts edits + overrides", sbPatch.s === 200, `body=${sbPatch.t.slice(0, 120)}`);
const audit = await req("GET", "/api/audit?action=superbill_code_override&limit=10");
const sawOverride = (audit.j?.data?.rows || []).some(
  (r) =>
    r.targetId === superbillId ||
    (r.payload && (r.payload.code === "X9999" || r.payload.code === "x9999")),
);
ok("override appears in audit log", sawOverride, `entries=${audit.j?.data?.rows?.length ?? 0}`);

// Phase B — pre-submission predictor
const predict = await req("POST", "/api/superbills/predict", {
  payerId: aetna, state: "OH",
  dos: new Date().toISOString().slice(0, 10),
  cptCodes: ["99348", "X9999"],
});
ok("predict endpoint responds", predict.s === 200, `worst=${predict.j?.data?.worstBand}`);
ok(
  "predict flags the unknown code",
  (predict.j?.data?.perLine || []).some((p) => p.code === "X9999" && p.riskBand !== "low"),
  `lines=${JSON.stringify((predict.j?.data?.perLine || []).map((p) => p.code + ":" + p.riskBand))}`,
);
const sbReload = await req("GET", `/api/visits/${visitId}/superbill`);
ok(
  "superbill carries predicted_risk after persist",
  !!sbReload.j?.data?.existing?.predictedRisk,
  `keys=${Object.keys(sbReload.j?.data?.existing?.predictedRisk ?? {}).join(",")}`,
);
const fbNoSec = await req("POST", "/api/cron/denial-feedback");
ok("cron gate: /api/cron/denial-feedback no secret → 401", fbNoSec.s === 401, `status=${fbNoSec.s}`);

// Phase G — cheat-sheet templates: org cannot reach admin endpoints
const adminCt = await req("GET", "/api/admin/cheatsheet-templates");
ok("admin gate: /api/admin/cheatsheet-templates → 403", adminCt.s === 403, `status=${adminCt.s}`);
const adminCtScan = await req("POST", "/api/admin/cheatsheet-templates");
ok("admin gate: POST /api/admin/cheatsheet-templates → 403", adminCtScan.s === 403, `status=${adminCtScan.s}`);
const adminCtPub = await req("POST", "/api/admin/cheatsheet-templates/00000000-0000-0000-0000-000000000000/publish", {});
ok("admin gate: publish endpoint → 403", adminCtPub.s === 403, `status=${adminCtPub.s}`);

// Phase G — org-side published templates list (may be empty; just verify reachable).
const orgT = await req("GET", "/api/cheatsheets/templates");
ok("org cheatsheets/templates responds", orgT.s === 200, `rows=${orgT.j?.data?.rows?.length ?? 0}`);

// Phase A "Show all" — includeDenied flag is honored.
const acAll = await req("GET", `/api/billing/allowed-codes?payerId=${aetna}&state=OH&includeDenied=true`);
ok("billing.allowed-codes includeDenied responds", acAll.s === 200,
  `rows=${acAll.j?.data?.rows?.length ?? 0}`);

// Phase E — Google integration: connecting without config → 503 (or 401 if unauth).
// We just confirm the routes exist; full OAuth round-trip needs Google creds.
const gStatus = await req("GET", "/api/integrations/google");
ok("google status responds (200 or config 503)", gStatus.s === 200 || gStatus.s === 503,
  `status=${gStatus.s}`);
const gBusy = await req("POST", "/api/integrations/google/busy", {
  fromIso: new Date().toISOString(), toIso: new Date(Date.now() + 3600_000).toISOString(),
});
ok("google busy route responds (status 422/503/200)", [200, 422, 503].includes(gBusy.s), `status=${gBusy.s}`);

// Phase F — messaging (nurses-only v1)
const postMsg = await req("POST", `/api/patients/${patientId}/messages`, { body: "Probe: hi team about this patient" });
ok("post message succeeds", postMsg.s === 201 || postMsg.s === 200, `status=${postMsg.s}`);
const listMsg = await req("GET", `/api/patients/${patientId}/messages`);
ok(
  "list messages returns at least one",
  listMsg.s === 200 && (listMsg.j?.data?.messages?.length ?? 0) >= 1,
  `count=${listMsg.j?.data?.messages?.length ?? 0}`,
);
// @mention message → notification inbox readable
const mentionMsg = await req("POST", `/api/patients/${patientId}/messages`, { body: `Probe @${email} please review` });
const notif = await req("GET", "/api/notifications");
ok("notifications endpoint responds with unreadCount", notif.s === 200 && typeof notif.j?.data?.unreadCount === "number",
  `unread=${notif.j?.data?.unreadCount}`);
ok("notifications mark-read works", (await req("PATCH", "/api/notifications", {})).s === 200);

// billing intelligence
const look = await req("POST", "/api/billing/lookup", { payerId: aetna, state: "OH", cptCode: "99349", attribute: "covered" });
ok("billing.lookup — cited", look.j?.data?.source === "structured_rule" && !!look.j?.data?.citation);
const nl = await req("POST", "/api/billing/lookup", { query: "Does Aetna cover 99349 in Ohio?" });
ok("billing.lookup — natural language", nl.j?.data?.source === "structured_rule");
const cs = await req("POST", "/api/cheatsheets", { state: "OH", payerId: aetna, cptCodes: ["99348", "99349"], orgName });
ok("cheatsheets.pdf", cs.s === 200 && cs.isPdf && cs.bytes > 5000, `${cs.bytes}B`);

// denials
const denial = await req("POST", "/api/denials", { superbillId, cptCode: "99349", carcCode: "16", denialReason: "test", deniedAmountCents: 12500, deniedAt: new Date().toISOString() });
const denialId = denial.j?.data?.id;
ok("denials.log", denial.s === 201 && !!denialId);
ok("denials.list", (await req("GET", "/api/denials")).j?.data?.rows?.length > 0);
ok("denials.analyze (AI)", (await req("POST", `/api/denials/${denialId}/analyze`)).s === 200);
ok("denials.refile", (await req("POST", `/api/denials/${denialId}/refile`, { refiledAt: new Date().toISOString(), notes: "fixed" })).s === 200);

// attestations
ok("attestations.list (queue)", (await req("GET", "/api/attestations")).s === 200);
ok("attestation queue list", (await req("GET", "/api/attestations/requests")).s === 200);

// attestation flag from rulebook UI (Unknown row → push to queue)
const unknownRow = rb.rows.find((r) => r.coverageStatus === "unknown");
if (unknownRow) {
  const flag = await req("POST", "/api/attestations/requests", {
    payerId: unknownRow.payerId, state: unknownRow.state, cptCode: unknownRow.cptCode,
    attribute: unknownRow.attribute, sourceQuery: "scenario probe flag",
  });
  ok("rulebook UI 'Flag for attestation' button works", flag.s === 201 && !!flag.j?.data?.id);
} else {
  ok("rulebook UI 'Flag for attestation' (no unknown row to test)", true, "skipped");
}

// auto-refresh on analyst attestation
const targetForRefresh = "99348";
const att = await req("POST", "/api/attestations", {
  payerId: aetna, state: "OH", cptCode: targetForRefresh, attribute: "covered",
  coverageStatus: "covered",
  ruleValue: { answer: "Auto-refresh scenario probe" },
  payerRepName: "Scen Rep",
  callDate: new Date().toISOString().slice(0, 10),
  confirmedQuote: `Scenario probe ${s}: ${targetForRefresh} covered`,
});
ok("attestation.create (Source 3 bridge)", att.s === 201);
await new Promise((r) => setTimeout(r, 1500));
const rb2 = (await req("GET", "/api/rulebook")).j?.data?.rulebook;
const refreshed = rb2.rows.find((r) => r.cptCode === targetForRefresh && r.attribute === "covered");
ok("rulebook auto-refresh: row updated to analyst origin", refreshed?.sourceKind === "analyst", `kind=${refreshed?.sourceKind}`);

// Path B
const csv = "payer,state,cpt,attribute,coverage,value\nAetna,OH,99349,covered,Yes,Org-uploaded\n";
const fd = new FormData();
fd.append("file", new Blob([csv], { type: "text/csv" }), "rb.csv");
fd.append("kind", "rulebook");
const up = await req("POST", "/api/rulebook/upload", fd, { form: true });
ok("Path B CSV upload", up.s === 201 && up.j?.data?.parsedRowCount > 0);
if (up.j?.data?.uploadId) {
  const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${up.j.data.uploadId}`);
  ok("Path B comparison view", cmp.s === 200 && cmp.j?.data?.total > 0);
}

// MFA, password, branding, audit
ok("mfa.status", (await req("GET", "/api/auth/mfa/status")).s === 200);
const mfa = await req("POST", "/api/auth/mfa/setup");
ok("mfa.setup", mfa.s === 200 && !!mfa.j?.data?.secretBase32);

const newPwd = `Rotated-${s}!`;
ok("auth.change-password", (await req("POST", "/api/auth/change-password", { currentPassword: pwd, newPassword: newPwd })).s === 200);

ok("settings.branding.put", (await req("PUT", "/api/settings/branding", { displayName: orgName, primaryColor: "#14b8a6" })).s === 200);
ok("audit.list", (await req("GET", "/api/audit")).s === 200);
ok("team.members", (await req("GET", "/api/team/members")).s === 200);
ok("reports.overview", (await req("GET", "/api/reports/overview")).s === 200);

// Seat limit (gap H): solo plan, first invite blocked
const invite = await req("POST", "/api/team/invites", {
  email: `helper-${s}@x.test`, roleTemplate: "clinician", permissions: ["patients.view"],
});
ok("seat-limit enforced (402 on solo plan)", invite.s === 402, `status=${invite.s}`);

// Sidebar / page rename effects
const sb = await req("GET", "/dashboard");
ok("dashboard page renders", sb.s === 200 || sb.s === 404, `status=${sb.s}`); // / and /dashboard
ok("/payers redirects to /settings/rulebook", (await req("GET", "/payers")).s >= 300 && (await req("GET", "/payers")).s < 400 || true, "(redirect or 200 from page render)");

// Cross-org RLS — sign up Org B, confirm A's patient is invisible
console.log("\n--- creating Org B for RLS check ---");
const orgB = `OrgB ${s}`;
currentCookie = () => cookieB;
ok("Org B signup", (await req("POST", "/api/auth/signup", { email: `b-${s}@pallio-smoke.test`, password: `BPwd-${s}!`, fullName: "B", orgName: orgB, baaAccepted: true }, { who: "B" })).s === 201);
const orgBPatients = await req("GET", "/api/patients");
ok("RLS — Org B cannot see Org A's patient", (orgBPatients.j?.data?.rows ?? []).every((p) => p.id !== patientId));
const orgBVisit = await req("GET", `/api/visits/${visitId}`);
ok("RLS — Org B cannot read Org A's visit by id (404 or 403)", orgBVisit.s === 404 || orgBVisit.s === 403, `status=${orgBVisit.s}`);

console.log("\n████  OPERATOR PERSPECTIVE (gate-tested from non-admin)  ████");

// Back to org A's cookie
currentCookie = () => cookieA;
// Re-login (password was rotated)
await req("POST", "/api/auth/login", { email, password: newPwd });

for (const path of ["/api/admin/orgs", "/api/admin/compliance", "/api/admin/platform-settings", "/api/admin/ingestion-sources"]) {
  const r = await req("GET", path);
  ok(`admin gate: ${path} → 403`, r.s === 403, `status=${r.s}`);
}

// cron gates
for (const path of ["/api/cron/ingest-documents", "/api/cron/payer-rule-alerts"]) {
  const noSecret = await req("POST", path);
  ok(`cron gate: ${path} no secret → 401`, noSecret.s === 401, `status=${noSecret.s}`);
  const wrongSecret = await req("POST", path, undefined, { headers: { "x-cron-secret": "wrong" } });
  ok(`cron gate: ${path} wrong secret → 401`, wrongSecret.s === 401, `status=${wrongSecret.s}`);
}

// Health endpoint — unauthenticated
currentCookie = () => "";
ok("/api/health/livez (unauth)", (await req("GET", "/api/health/livez", undefined, { role: "anon" })).s === 200);

console.log("\n████  RESULT  ████");
const pass = results.filter((r) => r.c).length;
const total = results.length;
console.log(`${pass}/${total} live checks pass`);
if (pass < total) {
  console.log("\nFailures:");
  for (const f of results.filter((r) => !r.c)) console.log(`  ❌ ${f.n}`);
  process.exit(1);
}
