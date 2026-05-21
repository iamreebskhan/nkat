/**
 * Verify the document-ingestion pipeline end-to-end on production:
 *   1. CSV rulebook  → /api/rulebook/upload → comparison → merge
 *   2. policy doc     → /api/rulebook/upload?kind=document → chunks
 *   3. confirm merged rows appear in /api/rulebook
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const stamp = Date.now();
const EMAIL = `ing-${stamp}@pallio-smoke.test`;
const PASSWORD = `IngPass-${stamp}!`;
const ORG = `Ing ${stamp}`;

let cookie = "";
async function req(m, p, b, isForm) {
  const headers = { ...(cookie ? { cookie } : {}) };
  let body;
  if (b !== undefined) {
    if (isForm) body = b;
    else { headers["content-type"] = "application/json"; body = JSON.stringify(b); }
  }
  const r = await fetch(BASE + p, { method: m, headers, body, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) {
    const x = c.match(/^pallio_session=([^;]*)/);
    if (x) cookie = `pallio_session=${x[1]}`;
  }
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}

(async () => {
  await req("POST", "/api/auth/signup", {
    email: EMAIL, password: PASSWORD, fullName: "Ing", orgName: ORG, baaAccepted: true,
  });
  // onboarding so rulebook ops are allowed
  await req("POST", "/api/onboarding/profile", { name: ORG, npi: "1234567890", orgType: "palliative" });

  // ---- 1. CSV rulebook upload ----
  const csv = [
    "Payer,State,CPT,Attribute,Covered?,Notes",
    "Aetna,OH,99349,covered,Yes,Org says covered established home visit",
    "Aetna,OH,99349,prior_auth,No,Org says no PA",
    "Aetna,OH,99350,covered,Yes,Org-only rule not in Pallio source",
    "Anthem,OH,99348,covered,Yes,Org covered",
  ].join("\n");
  const fd = new FormData();
  fd.append("file", new Blob([csv], { type: "text/csv" }), "rulebook.csv");
  fd.append("kind", "rulebook");
  const up = await req("POST", "/api/rulebook/upload", fd, true);
  console.log("=== CSV upload ===");
  console.log("status", up.s, "→", JSON.stringify(up.j?.data ?? up.j?.error));
  const uploadId = up.j?.data?.uploadId;

  // ---- 2. comparison ----
  const cmp = await req("GET", `/api/rulebook/comparison?uploadId=${uploadId}`);
  console.log("\n=== Comparison ===");
  console.log("status", cmp.s, "rows", cmp.j?.data?.total, "summary", JSON.stringify(cmp.j?.data?.summary));
  const rows = cmp.j?.data?.rows ?? [];
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${r.state}/${r.cptCode}/${r.attribute} outcome=${r.outcome} org=${r.orgValue?.coverageStatus ?? "-"} src=${r.sourceValue?.coverageStatus ?? "-"}`);
  }

  // ---- 3. merge (take source where present, else org) ----
  const decisions = rows.map((r) => {
    const chosen = r.sourceValue ?? r.orgValue;
    return chosen && {
      payerId: r.payerId, state: r.state, cptCode: r.cptCode,
      attribute: r.attribute, coverageStatus: chosen.coverageStatus, ruleValue: chosen.ruleValue,
    };
  }).filter(Boolean);
  const mg = await req("POST", "/api/rulebook/merge", { uploadId, decisions });
  console.log("\n=== Merge ===");
  console.log("status", mg.s, "→", JSON.stringify(mg.j?.data ?? mg.j?.error));

  // ---- 4. confirm in org rulebook ----
  const rb = await req("GET", "/api/rulebook");
  const grows = rb.j?.data?.rows ?? rb.j?.data?.rulebook?.rows ?? [];
  const uploaded = grows.filter((r) => (r.origin === "org_upload"));
  console.log("\n=== Org rulebook after merge ===");
  console.log("total rows", grows.length, "| org_upload origin", uploaded.length);

  // ---- 5. policy doc → chunks + RAG ----
  const policy = `Aetna Ohio Palliative Policy 2026.

Section 4: Home visit code 99350 (established patient, high complexity, 60 minutes)
is a COVERED service when medical necessity for the home setting is documented.
Prior authorization is NOT required for 99350. Telehealth delivery of 99350 is
permitted via synchronous audio-video with modifier 95.`;
  const fd2 = new FormData();
  fd2.append("file", new Blob([policy], { type: "text/plain" }), "aetna-policy.txt");
  fd2.append("kind", "document");
  fd2.append("state", "OH");
  fd2.append("title", "Aetna OH Palliative Policy 2026");
  const doc = await req("POST", "/api/rulebook/upload", fd2, true);
  console.log("\n=== Policy doc ingest ===");
  console.log("status", doc.s, "→", JSON.stringify(doc.j?.data ?? doc.j?.error));

  console.log("\n=== VERDICT ===");
  const ok =
    up.s === 201 && cmp.s === 200 && rows.length > 0 &&
    mg.s === 200 && mg.j?.data?.merged > 0 &&
    uploaded.length > 0 && doc.s === 201 && doc.j?.data?.chunkCount > 0;
  console.log(ok
    ? `✅ Ingestion works: CSV→${rows.length} reconciled→${mg.j?.data?.merged} merged (${uploaded.length} in rulebook); doc→${doc.j?.data?.chunkCount} chunks (embedded=${doc.j?.data?.embedded}).`
    : "❌ Pipeline incomplete — see above.");
})().catch((e) => { console.error("probe crashed:", e); process.exit(2); });
