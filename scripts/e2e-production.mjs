/**
 * End-to-end smoke test against https://app.pallio.io.
 *
 * Creates a throwaway org + admin user, walks the golden path:
 *   signup -> profile -> create patient -> schedule visit -> document
 *   -> superbill -> billing lookup -> logout
 *
 * Prints PASS/FAIL per step + a final summary. Exits non-zero on any failure.
 */

const BASE = process.env.BASE_URL || "https://app.pallio.io";

const stamp = Date.now();
const ORG_NAME = `E2E Smoke ${stamp}`;
const EMAIL = `e2e-${stamp}@pallio-smoke.test`;
const PASSWORD = `E2eSmokePass-${stamp}!`;
const FULL_NAME = `E2E Smoke ${stamp}`;

let cookie = "";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "✅ PASS" : "❌ FAIL";
  console.log(`${tag}  ${name}${detail ? "  — " + detail : ""}`);
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const set = res.headers.getSetCookie?.() || res.headers.raw?.()["set-cookie"] || [];
  for (const c of set) {
    const m = c.match(/^pallio_session=([^;]*)/);
    if (m) cookie = `pallio_session=${m[1]}`;
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function main() {
  console.log(`\nE2E target: ${BASE}`);
  console.log(`Throwaway org:   ${ORG_NAME}`);
  console.log(`Throwaway email: ${EMAIL}\n`);

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
    record("signup", ok, `status=${r.status} cookie=${cookie ? "set" : "MISSING"} err=${r.json?.error ?? ""}`);
    if (!ok) {
      console.log("Body:", r.text.slice(0, 500));
      return;
    }
  }

  // 2. /me round-trip
  let session;
  {
    const r = await req("GET", "/api/auth/me");
    session = r.json?.data;
    const ok = r.status === 200 && session?.email === EMAIL;
    record("auth.me", ok, `role=${session?.role} perms=${session?.permissions?.length ?? 0}`);
  }

  // 3. Save onboarding profile
  {
    const r = await req("POST", "/api/onboarding/profile", {
      name: ORG_NAME,
      npi: "1234567890",
      orgType: "palliative",
      notes: "E2E smoke org",
    });
    record("onboarding.profile", r.status === 200, `status=${r.status} err=${r.json?.error ?? ""}`);
  }

  // 4. Create patient
  let patientId;
  {
    const r = await req("POST", "/api/patients", {
      demographics: {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1940-06-15",
        sexAssignedAtBirth: "F",
        addressLine1: "10 Test St",
        city: "Cincinnati",
        state: "OH",
        zip: "45202",
        phone: "513-555-0123",
      },
      insurance: {},
      clinical: { palliativeReferralReason: "E2E smoke patient" },
      consents: {
        hipaaAcknowledged: true,
        goalsOfCareConsent: true,
        telehealthConsent: true,
        signedBy: "E2E Smoke",
        signedAt: "2026-05-15",
      },
      careTeam: {},
    });
    patientId = r.json?.data?.id;
    const ok = r.status === 201 && patientId;
    record("patients.create", ok, `id=${patientId ?? "—"} err=${r.json?.error ?? ""}`);
    if (!ok) console.log("Body:", r.text.slice(0, 400));
  }

  // 5. List patients includes the new one
  {
    const r = await req("GET", "/api/patients");
    const rows = r.json?.data?.rows || r.json?.data || [];
    const found = Array.isArray(rows) && rows.some((p) => p.id === patientId);
    record("patients.list", r.status === 200 && found, `total=${rows.length}`);
  }

  // 6. Schedule a visit
  let visitId;
  if (patientId) {
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
    record("visits.schedule", r.status === 201 && !!visitId, `id=${visitId ?? "—"} err=${r.json?.error ?? ""}`);
    if (!visitId) console.log("Body:", r.text.slice(0, 400));
  }

  // 7. Document the visit
  if (visitId) {
    const r = await req("PATCH", `/api/visits/${visitId}/document`, {
      totalMinutes: 45,
      documentText: "E2E smoke test — chief complaint: pain management. Stable.",
      cptCodesAssigned: ["99349"],
      icd10Codes: ["Z51.5"],
    });
    record("visits.document", r.status === 200 || r.status === 201, `status=${r.status} err=${r.json?.error ?? ""}`);
  }

  // 8. Generate superbill draft
  if (visitId) {
    const r = await req("GET", `/api/visits/${visitId}/superbill`);
    const has = !!(r.json?.data?.draft || r.json?.data?.existing);
    record("superbills.draft", r.status === 200 && has, `status=${r.status} hasDraft=${has}`);

    const r2 = await req("POST", `/api/visits/${visitId}/superbill`);
    record("superbills.persist", r2.status === 200 || r2.status === 201, `status=${r2.status} err=${r2.json?.error ?? ""}`);
  }

  // 9. Billing lookup
  {
    const payers = await req("GET", "/api/billing/payers");
    const list = payers.json?.data?.payers || payers.json?.data?.rows || [];
    const humana = list.find((p) => /humana/i.test(p.name || ""));
    record("billing.payers.list", payers.status === 200 && list.length > 0, `count=${list.length}`);

    if (humana) {
      const r = await req("POST", "/api/billing/lookup", {
        payerId: humana.id,
        state: "OH",
        cptCode: "99349",
        attribute: "covered",
      });
      const ok = r.status === 200 && r.json?.success === true && r.json?.data;
      record("billing.lookup", ok, `source=${r.json?.data?.source ?? "?"} confidence=${r.json?.data?.confidence ?? "?"}`);
    }
  }

  // 10. Logout
  {
    const r = await req("POST", "/api/auth/logout");
    record("auth.logout", r.status === 200, `status=${r.status}`);
  }

  // 11. Post-logout /me must 401
  {
    const r = await req("GET", "/api/auth/me");
    record("auth.me-after-logout", r.status === 401, `status=${r.status}`);
  }

  // Summary
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n=== ${pass}/${total} steps passed ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nE2E crashed:", err);
  process.exit(2);
});
