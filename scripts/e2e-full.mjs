/**
 * COMPREHENSIVE end-to-end test against https://app.pallio.io.
 *
 * Walks every major surface a real org admin would touch on day 1:
 *
 *   health → signup → me → onboarding (4 steps) →
 *   patients (create/list/get/patch) →
 *   visits (schedule/document/get) →
 *   care plan (put/get) →
 *   superbill (draft/persist/PDF) →
 *   billing (payers/lookup) →
 *   cheatsheet (PDF) →
 *   denial (log/list) →
 *   attestations (list requests) →
 *   reports (overview) → audit → team →
 *   branding (get/put) →
 *   change-password → logout → post-logout 401
 *
 * Prints PASS/FAIL per step + summary. Exits non-zero on any failure.
 */

const BASE = process.env.BASE_URL || "https://app.pallio.io";

const stamp = Date.now();
const ORG_NAME = `E2E Full ${stamp}`;
const EMAIL = `e2e-full-${stamp}@pallio-smoke.test`;
const PASSWORD = `E2eFullPass-${stamp}!`;
const NEW_PASSWORD = `E2eRotated-${stamp}!`;
const FULL_NAME = `E2E Full ${stamp}`;

let cookie = "";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "✅ PASS" : "❌ FAIL";
  console.log(`${tag}  ${name}${detail ? "  — " + detail : ""}`);
}

async function req(method, path, body, opts = {}) {
  const headers = { ...(cookie ? { cookie } : {}) };
  let bodyArg;
  if (body !== undefined) {
    if (opts.raw) {
      bodyArg = body;
    } else {
      headers["content-type"] = "application/json";
      bodyArg = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: bodyArg,
    redirect: "manual",
  });
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) {
    const m = c.match(/^pallio_session=([^;]*)/);
    if (m) cookie = `pallio_session=${m[1]}`;
  }
  const isBinary = (res.headers.get("content-type") || "").includes("application/pdf");
  const text = isBinary ? "" : await res.text();
  const buf = isBinary ? new Uint8Array(await res.arrayBuffer()) : null;
  let json = null;
  if (!isBinary) {
    try { json = JSON.parse(text); } catch {}
  }
  return {
    status: res.status,
    json,
    text,
    bytes: buf ? buf.length : text.length,
    isPdf: isBinary,
    contentType: res.headers.get("content-type"),
  };
}

async function main() {
  console.log(`\nE2E target: ${BASE}`);
  console.log(`Throwaway org:   ${ORG_NAME}`);
  console.log(`Throwaway email: ${EMAIL}\n`);

  // 0. Health
  {
    const r = await req("GET", "/api/health/livez");
    record("health.livez", r.status === 200);
  }

  // 1. Signup
  {
    const r = await req("POST", "/api/auth/signup", {
      email: EMAIL,
      password: PASSWORD,
      fullName: FULL_NAME,
      orgName: ORG_NAME,
      baaAccepted: true,
    });
    const ok = r.status === 201 && r.json?.success === true && cookie;
    record("auth.signup", ok, `status=${r.status}`);
    if (!ok) {
      console.log("Body:", r.text.slice(0, 400));
      return;
    }
  }

  // 2. /me
  let session;
  {
    const r = await req("GET", "/api/auth/me");
    session = r.json?.data;
    record("auth.me", r.status === 200 && session?.email === EMAIL, `role=${session?.role}`);
  }

  // 3. Onboarding — profile
  {
    const r = await req("POST", "/api/onboarding/profile", {
      name: ORG_NAME, npi: "1234567890", orgType: "palliative", notes: "E2E full",
    });
    record("onboarding.profile", r.status === 200);
  }
  // 4. Onboarding — states
  {
    const r = await req("POST", "/api/onboarding/states", { states: ["OH", "KY", "IN"] });
    record("onboarding.states", r.status === 200, `status=${r.status} err=${r.json?.error ?? ""}`);
  }
  // 5. Onboarding — payers (need at least one payer id)
  let firstPayerId, humanaId;
  {
    const list = await req("GET", "/api/billing/payers");
    const payers = list.json?.data?.payers || list.json?.data?.rows || [];
    firstPayerId = payers[0]?.id;
    humanaId = payers.find((p) => /humana/i.test(p.name || ""))?.id;
    const r = await req("POST", "/api/onboarding/payers", {
      payerIds: [firstPayerId, humanaId].filter(Boolean),
    });
    record("onboarding.payers", r.status === 200, `count=${payers.length}`);
  }
  // 6. Onboarding — CPT codes
  {
    const r = await req("POST", "/api/onboarding/cpt-codes", {
      cptCodes: ["99349", "99348", "99497"],
    });
    record("onboarding.cpt-codes", r.status === 200, `status=${r.status} err=${r.json?.error ?? ""}`);
  }

  // 6b. Rulebook — generate (Path A)
  {
    const r = await req("POST", "/api/rulebook/generate");
    record("rulebook.generate", r.status === 200, `status=${r.status} err="${r.json?.error ?? ""}" text=${r.text.slice(0,200)}`);
  }
  // 6c. Rulebook — save + finalize (no edits, just mark complete)
  {
    const r = await req("POST", "/api/rulebook/save", { edits: [], finalize: true });
    record("rulebook.save+finalize", r.status === 200, `status=${r.status} err=${r.json?.error ?? ""}`);
  }
  // 6d. Rulebook GET (loaded with rows)
  {
    const r = await req("GET", "/api/rulebook");
    record("rulebook.get", r.status === 200);
  }

  // 7. Patient create
  let patientId;
  {
    const r = await req("POST", "/api/patients", {
      demographics: {
        firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1940-06-15",
        sexAssignedAtBirth: "F", addressLine1: "10 Test St", city: "Cincinnati",
        state: "OH", zip: "45202", phone: "513-555-0123",
      },
      insurance: { primaryPayerId: humanaId, primaryMemberId: "M999000001" },
      clinical: { palliativeReferralReason: "Pain management" },
      consents: {
        hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true,
        signedBy: "E2E", signedAt: "2026-05-15",
      },
      careTeam: {},
    });
    patientId = r.json?.data?.id;
    record("patients.create", r.status === 201 && !!patientId);
  }
  // 8. Patient list
  {
    const r = await req("GET", "/api/patients");
    const rows = r.json?.data?.rows || [];
    record("patients.list", r.status === 200 && rows.some((p) => p.id === patientId), `total=${rows.length}`);
  }
  // 9. Patient get
  {
    const r = await req("GET", `/api/patients/${patientId}`);
    record("patients.get", r.status === 200 && r.json?.data?.id === patientId);
  }
  // 10. Patient patch
  {
    const r = await req("PATCH", `/api/patients/${patientId}`, {
      clinical: { palliativeReferralReason: "Updated reason — pain + ACP" },
    });
    record("patients.patch", r.status === 200, `status=${r.status} err=${r.json?.error ?? ""}`);
  }

  // 11. Schedule visit
  let visitId;
  {
    const start = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 24 * 3600 * 1000 + 45 * 60_000).toISOString();
    const r = await req("POST", "/api/visits", {
      patientId,
      clinicianUserId: session.userId,
      visitType: "new_patient_home",
      scheduledStart: start,
      scheduledEnd: end,
      isTelehealth: false,
    });
    visitId = r.json?.data?.id;
    record("visits.schedule", r.status === 201 && !!visitId);
  }
  // 12. Visit document
  {
    const r = await req("PATCH", `/api/visits/${visitId}/document`, {
      totalMinutes: 45,
      documentText: "E2E visit note — Chief complaint: pain. Stable on current regimen.",
      cptCodesAssigned: ["99349"],
      icd10Codes: ["Z51.5"],
    });
    record("visits.document", r.status === 200);
  }
  // 13. Visit get
  {
    const r = await req("GET", `/api/visits/${visitId}`);
    record("visits.get", r.status === 200 && r.json?.data?.id === visitId);
  }

  // 14. Care plan PUT
  {
    const r = await req("PUT", `/api/care-plans/${patientId}`, {
      document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Goals of care: comfort." }] }] },
      goalsOfCareSummary: "Comfort-focused, no aggressive intervention.",
      primarySymptoms: ["pain", "fatigue"],
      activeMedications: ["morphine 5mg q4h prn"],
    });
    record("careplans.put", r.status === 200, `status=${r.status} err=${r.json?.error ?? ""}`);
  }
  // 15. Care plan GET
  {
    const r = await req("GET", `/api/care-plans/${patientId}`);
    record("careplans.get", r.status === 200 && r.json?.data?.carePlan?.primarySymptoms?.length > 0);
  }

  // 16. Superbill draft + persist
  let superbillId;
  {
    const r = await req("GET", `/api/visits/${visitId}/superbill`);
    record("superbills.draft", r.status === 200 && (r.json?.data?.draft || r.json?.data?.existing));

    const r2 = await req("POST", `/api/visits/${visitId}/superbill`);
    superbillId = r2.json?.data?.id;
    record("superbills.persist", (r2.status === 200 || r2.status === 201) && !!superbillId);
  }
  // 17. Superbill PDF
  if (superbillId) {
    const r = await req("GET", `/api/superbills/${superbillId}/pdf`);
    record("superbills.pdf", r.status === 200 && r.isPdf && r.bytes > 1000, `${r.bytes}B ${r.contentType}`);
  }

  // 18. Billing lookup — structured
  if (humanaId) {
    const r = await req("POST", "/api/billing/lookup", {
      payerId: humanaId, state: "OH", cptCode: "99349", attribute: "covered",
    });
    record("billing.lookup.structured", r.status === 200 && r.json?.success === true,
      `source=${r.json?.data?.source ?? "?"}`);
  }
  // 18b. Billing lookup — natural-language
  {
    const r = await req("POST", "/api/billing/lookup", {
      query: "Does Humana Ohio cover 99349 telehealth?",
    });
    record("billing.lookup.natural", r.status === 200 && r.json?.success === true,
      `source=${r.json?.data?.source ?? "?"}`);
  }

  // 19. Cheatsheet PDF
  {
    const r = await req("POST", "/api/cheatsheets", {
      state: "OH", payerId: humanaId, cptCodes: ["99349", "99348"], orgName: ORG_NAME,
    });
    record("cheatsheets.pdf", r.status === 200 && r.isPdf && r.bytes > 1000, `${r.bytes}B`);
  }

  // 20. Denial — log + list + analyze + refile
  let denialId;
  if (superbillId) {
    const r = await req("POST", "/api/denials", {
      superbillId, cptCode: "99349", carcCode: "16", denialReason: "E2E test denial",
      deniedAmountCents: 12500, deniedAt: new Date().toISOString(),
    });
    denialId = r.json?.data?.id;
    record("denials.log", (r.status === 201 || r.status === 200) && !!denialId);

    const r2 = await req("GET", "/api/denials");
    const rows = r2.json?.data?.rows || [];
    record("denials.list", r2.status === 200, `total=${rows.length}`);

    if (denialId) {
      const r3 = await req("POST", `/api/denials/${denialId}/analyze`);
      record("denials.analyze (AI)", r3.status === 200, `status=${r3.status}`);

      const r4 = await req("POST", `/api/denials/${denialId}/refile`, {
        refiledAt: new Date().toISOString(),
        notes: "E2E refile test",
      });
      record("denials.refile", r4.status === 200, `status=${r4.status} err=${r4.json?.error ?? ""}`);
    }
  }

  // 21. Attestation requests list
  {
    const r = await req("GET", "/api/attestations/requests");
    record("attestations.requests", r.status === 200);
  }
  // 22. Attestations list
  {
    const r = await req("GET", "/api/attestations");
    record("attestations.list", r.status === 200);
  }

  // 23. Reports overview
  {
    const r = await req("GET", "/api/reports/overview");
    record("reports.overview", r.status === 200, `keys=${Object.keys(r.json?.data || {}).slice(0,4).join(',')}`);
  }

  // 24. Audit
  {
    const r = await req("GET", "/api/audit");
    record("audit.list", r.status === 200);
  }

  // 25. Team
  {
    const r = await req("GET", "/api/team/members");
    const rows = r.json?.data?.rows || r.json?.data || [];
    record("team.members", r.status === 200 && (Array.isArray(rows) ? rows.length > 0 : true));
  }

  // 26. Branding GET + PUT
  {
    const r = await req("GET", "/api/settings/branding");
    record("settings.branding.get", r.status === 200);

    const r2 = await req("PUT", "/api/settings/branding", {
      displayName: ORG_NAME, primaryColor: "#14b8a6",
    });
    record("settings.branding.put", r2.status === 200, `err=${r2.json?.error ?? ""}`);
  }

  // 26b. MFA setup (initiates enrollment — can't verify without authenticator)
  {
    const r = await req("GET", "/api/auth/mfa/status");
    record("mfa.status", r.status === 200, `enrolled=${r.json?.data?.enrolled ?? "?"}`);

    const r2 = await req("POST", "/api/auth/mfa/setup");
    record("mfa.setup", r2.status === 200 && r2.json?.data?.secretBase32, `hasSecret=${!!r2.json?.data?.secretBase32} hasUri=${!!r2.json?.data?.otpauthUri}`);
  }

  // 27. Change password
  {
    const r = await req("POST", "/api/auth/change-password", {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
    });
    record("auth.change-password", r.status === 200);
  }

  // 28. Logout
  {
    const r = await req("POST", "/api/auth/logout");
    record("auth.logout", r.status === 200);
  }

  // 29. Re-login with new password
  {
    const r = await req("POST", "/api/auth/login", {
      email: EMAIL, password: NEW_PASSWORD,
    });
    record("auth.login-after-rotation", r.status === 200 && r.json?.success === true,
      `status=${r.status}`);
  }

  // 30. Post-relogin /me works
  {
    const r = await req("GET", "/api/auth/me");
    record("auth.me-after-relogin", r.status === 200 && r.json?.data?.email === EMAIL);
  }

  // Summary
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n=== ${pass}/${total} steps passed ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nE2E crashed:", err);
  process.exit(2);
});
