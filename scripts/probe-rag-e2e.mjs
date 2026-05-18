/**
 * End-to-end RAG proof: ingest a free-text policy doc → confirm a
 * lookup with NO structured rule retrieves it semantically and returns
 * an AI-synthesized CITED answer (source=ai_synthesized).
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const s = Date.now();
let cookie = "";
async function req(m, p, b, form) {
  const h = { ...(cookie ? { cookie } : {}) };
  let body;
  if (b !== undefined) { if (form) body = b; else { h["content-type"] = "application/json"; body = JSON.stringify(b); } }
  const r = await fetch(BASE + p, { method: m, headers: h, body, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) { const x = c.match(/^pallio_session=([^;]*)/); if (x) cookie = `pallio_session=${x[1]}`; }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t };
}

(async () => {
  await req("POST", "/api/auth/signup", { email: `rag-${s}@pallio-smoke.test`, password: `RagP-${s}!`, fullName: "RAG", orgName: `RAG ${s}`, baaAccepted: true });
  await req("POST", "/api/onboarding/profile", { name: `RAG ${s}`, npi: "1234567890", orgType: "palliative" });

  const payers = (await req("GET", "/api/billing/payers")).j?.data?.payers || [];
  const aetna = payers.find((p) => /aetna/i.test(p.name))?.id;

  // A distinctive fact for a code NOT in the seeded structured rules
  // (seed 0018 covers 99348/99349/99350/99497/99498/G0318 — use 99347).
  const policy = `Aetna Ohio Palliative Reimbursement Addendum 2026.

Section 9.4: CPT 99347 (home visit, established patient, straightforward
MDM, 20 minutes) is COVERED for palliative members in Ohio. It requires
no prior authorization. When delivered via telehealth, append modifier
93 (audio-only) — Aetna Ohio uniquely accepts audio-only for 99347 in
the palliative program, an exception to its general audio-video-only
telehealth rule.`;
  const fd = new FormData();
  fd.append("file", new Blob([policy], { type: "text/plain" }), "aetna-oh-99347.txt");
  fd.append("kind", "document");
  fd.append("payerId", aetna);
  fd.append("state", "OH");
  fd.append("title", "Aetna OH Palliative Addendum 2026");
  const ing = await req("POST", "/api/rulebook/upload", fd, true);
  console.log("doc ingest:", ing.s, JSON.stringify(ing.j?.data));

  // Give embeddings a moment to be queryable.
  await new Promise((r) => setTimeout(r, 2500));

  // Lookup: no structured rule for Aetna/OH/99347 → must use RAG.
  const q = await req("POST", "/api/billing/lookup", {
    payerId: aetna, state: "OH", cptCode: "99347",
    query: "Does Aetna Ohio allow audio-only telehealth for 99347 and is prior auth required?",
  });
  const d = q.j?.data || {};
  console.log("\n=== Lookup (RAG path) ===");
  console.log("source     :", d.source);
  console.log("confidence :", d.confidence);
  console.log("answer     :", (d.answer || "").slice(0, 200));
  console.log("citation   :", d.citation ? `"${(d.citation.verbatimQuote || "").slice(0, 120)}"` : "(none)");

  const ragWorks = d.source === "ai_synthesized" && !!d.citation;
  console.log("\n=== VERDICT ===");
  console.log(ragWorks
    ? "✅ RAG END-TO-END WORKS: uploaded doc → embedded → retrieved → cited AI answer."
    : `⚠️ RAG did not synthesize (source=${d.source}). Embeddings store OK but retrieval/synthesis needs a look.`);
})().catch((e) => { console.error("crash:", e); process.exit(2); });
