/**
 * Verify rulebook generation + cheat-sheet PDF now contain REAL rules
 * (the seeded 0018 corpus), not empty "unknown" placeholders.
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const stamp = Date.now();
const EMAIL = `rb-${stamp}@pallio-smoke.test`;
const PASSWORD = `RbPass-${stamp}!`;
const ORG = `RB ${stamp}`;

let cookie = "";
async function req(method, path, body, raw) {
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
  if (raw) return { status: res.status, bytes: (await res.arrayBuffer()).byteLength, ct: res.headers.get("content-type") };
  const t = await res.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t };
}

(async () => {
  await req("POST", "/api/auth/signup", {
    email: EMAIL, password: PASSWORD, fullName: "RB", orgName: ORG, baaAccepted: true,
  });

  const payers = await req("GET", "/api/billing/payers");
  const list = payers.json?.data?.payers || payers.json?.data?.rows || [];
  const pick = (n) => list.find((p) => new RegExp(n, "i").test(p.name || ""))?.id;
  const aetna = pick("Aetna");
  const anthem = pick("Anthem");
  const uhc = pick("UnitedHealthcare Community Plan Ohio");

  // Onboarding: profile → states(OH) → payers(seeded 3) → CPTs(seeded codes)
  await req("POST", "/api/onboarding/profile", { name: ORG, npi: "1234567890", orgType: "palliative" });
  await req("POST", "/api/onboarding/states", { states: ["OH"] });
  await req("POST", "/api/onboarding/payers", { payerIds: [aetna, anthem, uhc].filter(Boolean) });
  await req("POST", "/api/onboarding/cpt-codes", { cptCodes: ["99348", "99349", "99350", "99497", "99498", "G0318"] });

  // Generate rulebook (Path A) — should pull seeded payer_rule rows
  const gen = await req("POST", "/api/rulebook/generate");
  const rb = gen.json?.data?.rulebook;
  const rows = rb?.rows ?? gen.json?.data?.rows ?? [];
  console.log("=== Rulebook generate ===");
  console.log("status:", gen.status);
  console.log("rulebook id:", rb?.id, "version:", rb?.currentVersion);
  console.log("row count:", Array.isArray(rows) ? rows.length : "(rows not inlined — checking GET)");

  const rbGet = await req("GET", "/api/rulebook");
  const grows = rbGet.json?.data?.rows ?? rbGet.json?.data?.rulebook?.rows ?? [];
  const cited = grows.filter((r) => (r.coverageStatus ?? r.coverage_status) !== "unknown");
  console.log("GET /api/rulebook rows:", grows.length, "| non-unknown:", cited.length);
  if (cited[0]) console.log("sample cited cell:", JSON.stringify({
    code: cited[0].code, attr: cited[0].attribute,
    status: cited[0].coverageStatus ?? cited[0].coverage_status,
    origin: cited[0].origin,
  }));

  // Cheat sheet PDF
  const cs = await req("POST", "/api/cheatsheets", {
    state: "OH", payerId: aetna, cptCodes: ["99348", "99349", "99350", "99497"], orgName: ORG,
  }, true);
  console.log("\n=== Cheat sheet PDF ===");
  console.log(`status=${cs.status} bytes=${cs.bytes} type=${cs.ct}`);

  console.log("\n=== VERDICT ===");
  const ok = gen.status === 200 && grows.length > 0 && cited.length > 0 && cs.status === 200 && cs.bytes > 1000;
  console.log(ok
    ? `✅ Rulebook generated ${grows.length} rows (${cited.length} cited) + cheat-sheet PDF ${cs.bytes}B from real data.`
    : `❌ Something empty — gen=${gen.status} rows=${grows.length} cited=${cited.length} pdf=${cs.bytes}B`);
})().catch((e) => { console.error("crashed:", e); process.exit(2); });
