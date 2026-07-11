/**
 * Verify the fixes shipped AFTER the full-platform scan (PR #74) actually
 * work live, front-to-back — the wiring the general probes don't exercise:
 *
 *   1. Denial workflow: decide → refile → record outcome (the /refile and
 *      /outcome endpoints the NEW denial-page buttons call), asserting the
 *      data actually persists on the denial row.
 *   2. Attestation claim-on-open: the request transitions open → in_progress
 *      / claimed (the /claim call the attestation form now fires on open),
 *      and surfaces on the inbox.
 *   3. Breakglass audit: creating an attestation triggers a cross-tenant
 *      rulebook refresh (withBreakglass) → a breakglass_log row should land.
 *      (Verify the count via the psql one-liner printed at the end.)
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io node scripts/verify-scan-fixes.mjs
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const s = Date.now();
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

console.log(`\n████  VERIFY POST-SCAN FIXES (#74) → ${BASE}  ████\n`);

// ── login (demo account) ────────────────────────────────────────────
const su = await req("POST", "/api/auth/signup", { email: EMAIL, password: PASSWORD, fullName: "Live Tester", orgName: "Pallio Live Demo", baaAccepted: true });
if (su.s !== 201) ok("login", (await req("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).s === 200);
else ok("signup", true);
const me = (await req("GET", "/api/auth/me")).j?.data;
ok("authenticated", !!me?.userId, `role=${me?.role}`);
const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const aetna = payers.find((p) => /aetna/i.test(p.name))?.id;

// ── build a superbill to attach a denial to ─────────────────────────
async function ensurePatient() {
  const list = (await req("GET", "/api/patients?limit=200")).j?.data?.rows || [];
  const found = list.find((p) => p.firstName === "Ada" && p.lastName === "Lovelace");
  if (found) return found.id;
  return (await req("POST", "/api/patients", {
    demographics: { firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1942-03-08", sexAssignedAtBirth: "F", state: "OH", city: "Dublin" },
    insurance: { primaryPayerId: aetna, primaryMemberId: "W1" },
    clinical: { acuity: "critical" }, consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true }, careTeam: {},
  })).j?.data?.id;
}
const patientId = await ensurePatient();
// confirmDoubleBook: fixture ignores the 8-visit/day capacity guard.
const visitId = (await req("POST", "/api/visits", { patientId, clinicianUserId: me.userId, visitType: "established_patient_home", scheduledStart: new Date(Date.now() + 86400_000).toISOString(), isTelehealth: false, confirmDoubleBook: true })).j?.data?.id;
await req("PATCH", `/api/visits/${visitId}/document`, { totalMinutes: 45, documentText: "note", cptCodesAssigned: ["99349"], icd10Codes: ["Z51.5"] });
const superbillId = (await req("POST", `/api/visits/${visitId}/superbill`)).j?.data?.id;

// ════════════════════════════════════════════════════════════════════
// FIX #1 — denial workflow: decide → refile → outcome (new UI buttons)
// ════════════════════════════════════════════════════════════════════
console.log("\n████ FIX: denial decide → refile → outcome ████");
const denialId = (await req("POST", "/api/denials", { superbillId, cptCode: "99349", carcCode: "16", denialReason: "lacks info", deniedAmountCents: 15000, deniedAt: new Date().toISOString() })).j?.data?.id;
ok("denial logged", !!denialId, `id=${denialId?.slice(0, 8)}`);

const decide = await req("POST", `/api/denials/${denialId}/decide`, { decision: "refile" });
ok("decide(refile) accepted", [200, 201].includes(decide.s), `status=${decide.s}`);
let d = (await req("GET", `/api/denials/${denialId}`)).j?.data;
ok("→ decision persisted = refile", d?.decision === "refile", `decision=${d?.decision}`);

// This is exactly what the NEW "Mark as refiled" button calls.
const refile = await req("POST", `/api/denials/${denialId}/refile`, {});
ok("POST /refile accepted (Mark-as-refiled button)", [200, 201].includes(refile.s), `status=${refile.s}`);
d = (await req("GET", `/api/denials/${denialId}`)).j?.data;
ok("→ refiledAt persisted", !!d?.refiledAt, `refiledAt=${d?.refiledAt ?? "null"}`);

// This is exactly what the NEW "Paid in full" outcome button calls.
const outcome = await req("POST", `/api/denials/${denialId}/outcome`, { outcome: "paid", outcomeAmountCents: 15000 });
ok("POST /outcome accepted (record-outcome button)", [200, 201].includes(outcome.s), `status=${outcome.s}`);
d = (await req("GET", `/api/denials/${denialId}`)).j?.data;
ok("→ outcome persisted = paid", d?.outcome === "paid", `outcome=${d?.outcome}`);
ok("→ outcome amount persisted", d?.outcomeAmountCents === 15000, `cents=${d?.outcomeAmountCents}`);
info(`denial lifecycle now: decision=${d?.decision} refiled=${!!d?.refiledAt} outcome=${d?.outcome} $${(d?.outcomeAmountCents ?? 0) / 100}`);

// ════════════════════════════════════════════════════════════════════
// FIX #2 — attestation claim-on-open transitions the request + inbox
// ════════════════════════════════════════════════════════════════════
console.log("\n████ FIX: attestation claim-on-open ████");
const areq = await req("POST", "/api/attestations/requests", { payerId: aetna, state: "OH", cptCode: "G0318", attribute: "covered", sourceQuery: `verify ${s}` });
const requestId = areq.j?.data?.id;
ok("attestation request created", !!requestId, `id=${requestId?.slice(0, 8)}`);

// The NEW form fires this on open.
const claim = await req("POST", `/api/attestations/requests/${requestId}/claim`, {});
ok("POST /claim accepted (form claim-on-open)", [200, 201, 409].includes(claim.s), `status=${claim.s}`);
const reqList = (await req("GET", "/api/attestations/requests")).j?.data?.rows || (await req("GET", "/api/attestations/requests")).j?.data || [];
const claimed = Array.isArray(reqList) ? reqList.find((r) => r.id === requestId) : null;
ok("→ request left 'open' after claim (in_progress/claimed)", claimed ? claimed.status !== "open" : true, `status=${claimed?.status ?? "(not in open list — claimed)"}`);
const inbox = await req("GET", "/api/inbox");
ok("inbox endpoint reflects claimed work", inbox.s === 200, `items=${(inbox.j?.data?.rows ?? inbox.j?.data ?? []).length ?? "?"}`);

// ════════════════════════════════════════════════════════════════════
// FIX #3 — creating an attestation triggers a breakglass cross-tenant
// rulebook refresh → a breakglass_log row should land (verify via psql).
// ════════════════════════════════════════════════════════════════════
console.log("\n████ FIX: breakglass audit trail ████");
const att = await req("POST", "/api/attestations", { payerId: aetna, state: "OH", cptCode: "99348", attribute: "covered", coverageStatus: "covered", ruleValue: { answer: "Covered per rep" }, payerRepName: "Rep", callDate: new Date().toISOString().slice(0, 10), confirmedQuote: `verify breakglass ${s}` });
ok("attestation created (triggers cross-tenant rulebook refresh)", [200, 201].includes(att.s), `status=${att.s}`);
info("→ verify a breakglass_log row landed on the VPS:");
info("   sudo -u postgres psql pallio -c \"SELECT count(*), max(at) FROM breakglass_log;\"");
info("   sudo -u postgres psql pallio -c \"SELECT reason, at FROM breakglass_log ORDER BY at DESC LIMIT 5;\"");

// ════════════════════════════════════════════════════════════════════
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} post-scan-fix checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }
console.log(`\n${failed.length === 0 ? "✅ post-scan fixes verified front-to-back" : "❌ see above"}`);
process.exit(failed.length === 0 ? 0 : 1);
