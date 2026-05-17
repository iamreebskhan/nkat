/**
 * Post-seed probe: do lookups now return CITED answers?
 * Tests the exact payer × code × attribute combos seeded in 0018.
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const stamp = Date.now();
const EMAIL = `probe2-${stamp}@pallio-smoke.test`;
const PASSWORD = `Probe2Pass-${stamp}!`;
const ORG = `Probe2 ${stamp}`;

let cookie = "";
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = c.match(/^pallio_session=([^;]*)/);
    if (m) cookie = `pallio_session=${m[1]}`;
  }
  const t = await res.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t };
}

(async () => {
  await req("POST", "/api/auth/signup", {
    email: EMAIL, password: PASSWORD, fullName: "Probe2", orgName: ORG, baaAccepted: true,
  });

  const payers = await req("GET", "/api/billing/payers");
  const list = payers.json?.data?.payers || payers.json?.data?.rows || [];
  const byName = (n) => list.find((p) => new RegExp(n, "i").test(p.name || ""))?.id;

  // Combos that map onto seeded rules (0018).
  const combos = [
    ["Aetna",  "OH", "99349", "covered"],
    ["Aetna",  "OH", "99349", "prior_auth"],
    ["Aetna",  "OH", "99349", "telehealth"],
    ["Aetna",  "OH", "99349", "documentation"],
    ["Aetna",  "OH", "99497", "covered"],
    ["Aetna",  "OH", "99350", "frequency_limit"],
    ["UnitedHealthcare Community Plan Ohio", "OH", "99349", "covered"],
    ["UnitedHealthcare Community Plan Ohio", "OH", "99349", "prior_auth"],
    ["UnitedHealthcare Community Plan Ohio", "OH", "G0318", "covered"],
    ["UnitedHealthcare Community Plan Ohio", "OH", "99497", "telehealth"],
    ["Anthem", "OH", "99348", "covered"],
    ["Anthem", "OH", "99498", "covered"],
    ["Anthem", "OH", "99349", "modifier_required"],
    ["Anthem", "OH", "99349", "telehealth"],
    // Negative control — a combo with NO seeded rule, must stay unknown.
    ["Aetna",  "OH", "99214", "covered"],
  ];

  let cited = 0, unknown = 0;
  console.log(`\n=== Structured lookups (post-seed) — ${BASE} ===\n`);
  for (const [pname, state, code, attr] of combos) {
    const pid = byName(pname);
    if (!pid) { console.log(`  SKIP ${pname} (not in payer list)`); continue; }
    const r = await req("POST", "/api/billing/lookup", {
      payerId: pid, state, cptCode: code, attribute: attr,
    });
    const d = r.json?.data || {};
    const src = d.source ?? "?";
    const isCited = src !== "unknown" && !!d.citation;
    if (isCited) cited++; else unknown++;
    const quote = d.citation?.verbatimQuote ? `"${d.citation.verbatimQuote.slice(0, 70)}…"` : "(no citation)";
    console.log(`  ${pname.slice(0,28).padEnd(28)} ${code}/${attr.padEnd(16)} → ${src.padEnd(14)} conf=${d.confidence ?? "?"}`);
    if (isCited) console.log(`      ↳ ${quote}`);
    if (isCited) console.log(`      ↳ answer: ${(d.answer ?? "").slice(0, 90)}`);
  }

  // Natural language
  const aetna = byName("Aetna");
  const nl = await req("POST", "/api/billing/lookup", {
    query: "Does Aetna cover 99349 home visits in Ohio?",
    payerId: aetna, state: "OH", cptCode: "99349",
  });
  console.log(`\n=== Natural-language ===`);
  console.log(`  source=${nl.json?.data?.source} conf=${nl.json?.data?.confidence}`);
  console.log(`  answer: ${(nl.json?.data?.answer ?? "").slice(0, 140)}`);

  console.log(`\n=== VERDICT ===`);
  console.log(`${cited} cited / ${unknown} unknown (negative control SHOULD be 1 of the unknowns)`);
  console.log(cited >= 10
    ? "✅ Rule engine returns CITED answers from real data."
    : "❌ Still mostly unknown — investigate.");
})().catch((e) => { console.error("probe crashed:", e); process.exit(2); });
