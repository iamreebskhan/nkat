/**
 * Live verification: Source 3 (analyst → payer_rule) and the
 * AI-synth persist path. Sources 1 & 2 (document ingestion cron) are
 * verified separately from the VPS where the CRON_SECRET lives.
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const s = Date.now();
let cookie = "";
const results = [];
const ok = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

async function req(m, path, body, form) {
  const h = { ...(cookie ? { cookie } : {}) };
  let bodyArg;
  if (body !== undefined) {
    if (form) bodyArg = body;
    else { h["content-type"] = "application/json"; bodyArg = JSON.stringify(body); }
  }
  const r = await fetch(BASE + path, { method: m, headers: h, body: bodyArg, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) {
    const x = c.match(/^pallio_session=([^;]*)/); if (x) cookie = `pallio_session=${x[1]}`;
  }
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}

await req("POST", "/api/auth/signup", { email: `feed-${s}@pallio-smoke.test`, password: `Feed-${s}!`, fullName: "Feed", orgName: `Feed ${s}`, baaAccepted: true });

const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
const aetna = payers.find((p) => /aetna/i.test(p.name))?.id;

// ============================================================
// SOURCE 3: analyst attestation → payer_rule bridge
// Use a CPT not in seed 0018 so we know any structured_rule
// surfaced must have come from the bridge.
// ============================================================
console.log("\n=== Source 3 — analyst attestation bridge ===");
const targetCpt = "99204"; // not in seed 0018 — clean slate
const attr = "covered";

// Confirm the lookup is unknown before any attestation
const pre = await req("POST", "/api/billing/lookup", { payerId: aetna, state: "OH", cptCode: targetCpt, attribute: attr });
ok("pre-attestation lookup is unknown", pre.j?.data?.source === "unknown", `source=${pre.j?.data?.source}`);

// Create an attestation
const att = await req("POST", "/api/attestations", {
  payerId: aetna, state: "OH", cptCode: targetCpt, attribute: attr,
  coverageStatus: "covered",
  ruleValue: { answer: "Covered per analyst call confirmation" },
  payerRepName: "Test Rep",
  callDate: new Date().toISOString().slice(0, 10),
  confirmedQuote: "Aetna rep confirmed 99204 covered in OH on this date.",
});
ok("createAttestation succeeded", att.s === 201 || att.s === 200, `status=${att.s} id=${att.j?.data?.id?.slice(0, 8) ?? "?"}…`);

// Now the lookup should hit the mirrored payer_rule
const post = await req("POST", "/api/billing/lookup", { payerId: aetna, state: "OH", cptCode: targetCpt, attribute: attr });
const d = post.j?.data || {};
ok("post-attestation lookup is structured_rule", d.source === "structured_rule", `source=${d.source} conf=${d.confidence}`);
ok("answer cites the attestation quote", (d.citation?.verbatimQuote ?? "").includes("Aetna rep confirmed"));
ok("confidence reflects analyst-call band (~0.6)", d.confidence === 0.6, `conf=${d.confidence}`);

// ============================================================
// AI-SYNTHESIZED PERSIST: lookup with no structured rule but a
// matching ingested doc → ai_synthesized → next identical lookup
// should be structured_rule (the persist worked).
// ============================================================
console.log("\n=== AI-synth persist (close phase-6 TODO) ===");
const synthCpt = "99213"; // not in seed 0018 either

// Upload a free-text doc that mentions this CPT for Aetna OH
const policy = `Aetna Ohio supplemental coverage note 2026:
CPT 99213 is COVERED for established-patient outpatient E/M when delivered
in the office. No prior authorization required for 99213 in Ohio under
Aetna commercial plans.`;
const fd = new FormData();
fd.append("file", new Blob([policy], { type: "text/plain" }), "aetna-99213.txt");
fd.append("kind", "document");
fd.append("payerId", aetna);
fd.append("state", "OH");
fd.append("title", "Aetna OH 99213 supplemental note");
const ing = await req("POST", "/api/rulebook/upload", fd, true);
ok("policy doc ingested + embedded", ing.s === 201 && ing.j?.data?.embedded === true, `status=${ing.s} embedded=${ing.j?.data?.embedded}`);

await new Promise((r) => setTimeout(r, 3000)); // small grace for vector index

// First lookup → RAG path → ai_synthesized
const synth1 = await req("POST", "/api/billing/lookup", {
  payerId: aetna, state: "OH", cptCode: synthCpt, attribute: "covered",
  query: "Is CPT 99213 covered by Aetna in Ohio?",
});
const d1 = synth1.j?.data || {};
ok("first lookup returns ai_synthesized + citation", d1.source === "ai_synthesized" && !!d1.citation, `source=${d1.source}`);

await new Promise((r) => setTimeout(r, 2000));

// The persisted rule has confidence=0.4, which is BELOW
// MIN_SQL_CONFIDENCE=0.5 by design — AI-synth rules don't surface
// as authoritative structured_rule until an analyst confirms them
// (which then writes a 0.6-confidence row via the analyst bridge).
// So the right proof of persistence is NOT "next lookup is
// structured_rule"; it's "the attestation queue picked up the AI
// rule for human review" (a side-effect of the persist).
const queue = await req("GET", "/api/attestations/requests");
const queued = (queue.j?.data?.rows ?? []).some(
  (r) => r.cptCode === synthCpt && r.attribute === "covered",
);
ok("AI-synth persisted: attestation_request queued for human review", queued,
  `queue_size=${queue.j?.data?.rows?.length ?? 0}`);

// ============================================================
const pass = results.filter((r) => r.c).length;
const total = results.length;
console.log(`\n=== ${pass}/${total} live checks pass ===`);
if (pass < total) process.exit(1);
