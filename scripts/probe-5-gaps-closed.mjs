/**
 * Final live verification for the 5 corpus-feeder gaps:
 *   1. platform_admin role gate (admin endpoints now reachable)
 *   2. /admin/ingestion-sources UI + manual-run endpoint
 *   3. Scheduled GitHub Actions cron (verified separately in the
 *      Actions tab via workflow_dispatch)
 *   4. Rulebook UI shows provenance (sourceKind) per attribute
 *   5. Org rulebooks auto-refresh when payer_rule changes (no
 *      manual Re-generate required)
 *
 * Runs as a fresh non-platform-admin user; platform-admin-only paths
 * are verified by 403 (proving the gate works) plus the user does a
 * browser walkthrough as their elevated account.
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const s = Date.now();
let cookie = "";
const results = [];
const ok = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

async function req(m, p, b, form) {
  const h = { ...(cookie ? { cookie } : {}) };
  let body;
  if (b !== undefined) { if (form) body = b; else { h["content-type"] = "application/json"; body = JSON.stringify(b); } }
  const r = await fetch(BASE + p, { method: m, headers: h, body, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) {
    const x = c.match(/^pallio_session=([^;]*)/); if (x) cookie = `pallio_session=${x[1]}`;
  }
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}

// fresh signup
await req("POST", "/api/auth/signup", { email: `gaps-${s}@pallio-smoke.test`, password: `Gp-${s}!`, fullName: "G", orgName: `G ${s}`, baaAccepted: true });

const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const aetna = payers.find((p) => /aetna/i.test(p.name))?.id;

// --- onboarding so we have a rulebook to inspect ---
await req("POST", "/api/onboarding/profile", { name: `G ${s}`, npi: "1234567890", orgType: "palliative" });
await req("POST", "/api/onboarding/states", { states: ["OH"] });
await req("POST", "/api/onboarding/payers", { payerIds: [aetna] });
await req("POST", "/api/onboarding/cpt-codes", { cptCodes: ["99348", "99349", "G0318"] });
await req("POST", "/api/rulebook/generate");

// ============================================================
// Gap 1 — platform_admin role gate enforced
// ============================================================
console.log("\n=== Gap 1: platform_admin gate ===");
const adminList = await req("GET", "/api/admin/ingestion-sources");
ok("admin endpoint refuses non-platform-admin (403)", adminList.s === 403,
  `status=${adminList.s} (this proves the role gate works; the operator account with is_platform_admin=true will get 200)`);

// ============================================================
// Gap 2 — admin UI + manual-run endpoint exist
// ============================================================
console.log("\n=== Gap 2: admin UI route + run endpoint ===");
const uiPage = await req("GET", "/admin/ingestion-sources");
ok("/admin/ingestion-sources page responds (200 — auth check is client-side)", uiPage.s === 200,
  `status=${uiPage.s}`);

const fakeRun = await req("POST", "/api/admin/ingestion-sources/00000000-0000-0000-0000-000000000000/run");
ok("admin run endpoint enforces platform_admin (403)", fakeRun.s === 403,
  `status=${fakeRun.s} err="${(fakeRun.j?.error ?? "").slice(0, 40)}"`);

// ============================================================
// Gap 3 — scheduled-crons.yml exists in repo (caller verifies in Actions tab)
// ============================================================
console.log("\n=== Gap 3: scheduled crons workflow ===");
console.log("(verified by GitHub Actions UI — workflow file shipped in PR #44)");

// ============================================================
// Gap 4 — Rulebook exposes sourceKind per row
// ============================================================
console.log("\n=== Gap 4: rulebook provenance ===");
const rb = (await req("GET", "/api/rulebook")).j?.data?.rulebook;
const sample = rb?.rows?.[0];
ok("rulebook row carries sourceKind", typeof sample?.sourceKind === "string", `sourceKind="${sample?.sourceKind}"`);
ok("rulebook row carries sourceCreatedBy", "sourceCreatedBy" in (sample ?? {}), `value="${sample?.sourceCreatedBy ?? "(null)"}"`);
const kinds = new Set(rb.rows.map((r) => r.sourceKind));
ok("rulebook contains multiple sourceKind values (crawler / unknown / analyst)", kinds.size >= 2,
  `kinds=${[...kinds].join(",")}`);

// ============================================================
// Gap 5 — Auto-refresh on analyst attestation
// Use a unique CPT so we control state.
// ============================================================
console.log("\n=== Gap 5: auto-refresh on payer_rule change ===");
// Attest a CPT THAT IS IN THE ORG'S RULEBOOK — otherwise the
// refresh has no row to update. 99348 is in onboarding above and
// seed 0018 gave it a 'manual' (test@pallio.io) source, so the
// expected transition is manual → analyst.
const targetCpt = "99348";

// snapshot the org's rulebook for this CPT BEFORE attesting
const before = rb.rows.find((r) => r.cptCode === targetCpt && r.attribute === "covered");
const beforeKind = before?.sourceKind ?? "(no row)";
const beforeConf = before?.confidence ?? null;
console.log(`  before attestation:  kind=${beforeKind} conf=${beforeConf}`);

// fire an analyst attestation
const att = await req("POST", "/api/attestations", {
  payerId: aetna, state: "OH", cptCode: targetCpt, attribute: "covered",
  coverageStatus: "covered",
  ruleValue: { answer: "Covered per analyst verification call" },
  payerRepName: "Test Rep",
  callDate: new Date().toISOString().slice(0, 10),
  confirmedQuote: `Auto-refresh probe ${s}: Aetna rep confirmed ${targetCpt} covered in OH`,
});
ok("createAttestation succeeded", att.s === 201 || att.s === 200, `status=${att.s} body=${att.t.slice(0, 220)}`);

// give the cross-org refresh a moment to commit
await new Promise((r) => setTimeout(r, 1500));

// re-load the rulebook — WITHOUT clicking Re-generate
const rb2 = (await req("GET", "/api/rulebook")).j?.data?.rulebook;
const after = rb2.rows.find((r) => r.cptCode === targetCpt && r.attribute === "covered");
console.log(`  after attestation:   kind=${after?.sourceKind} conf=${after?.confidence} quote="${(after?.sourceQuote ?? "").slice(0, 60)}"`);
ok("rulebook row auto-refreshed (sourceKind became analyst)", after?.sourceKind === "analyst",
  `before=${beforeKind} → after=${after?.sourceKind}`);
ok("rulebook row picked up analyst confidence (0.6)", after?.confidence === 0.6,
  `conf=${after?.confidence}`);
ok("rulebook row carries the attestation source_quote", (after?.sourceQuote ?? "").includes(`Auto-refresh probe ${s}`),
  `quote="${(after?.sourceQuote ?? "").slice(0, 80)}"`);

// ============================================================
const pass = results.filter((r) => r.c).length;
const total = results.length;
console.log(`\n=== ${pass}/${total} live checks pass ===`);
if (pass < total) process.exit(1);
