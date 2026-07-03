/**
 * Diagnose the Anthropic API key LIVE — which models this key can actually
 * use, and what exact error each one returns.
 *
 * Why: extraction worked on claude-sonnet-4-6, then started failing with
 * "credit balance is too low" right after the switch to claude-opus-4-8.
 * That message can be misleading — this pins down whether it's (a) the whole
 * account/org out of credits, (b) Opus-4.8-specific (model access / tier),
 * or (c) a key-vs-org mismatch. Raw fetch (no SDK retries) so every status,
 * header, and error body is shown verbatim.
 *
 * Cost if calls succeed: 3 calls x max_tokens 16 ≈ a fraction of a cent.
 *
 * Run on the VPS (key auto-read from .env):
 *   node scripts/diagnose-anthropic-api.mjs
 */
import { readFileSync, existsSync } from "node:fs";

// ── resolve the key exactly like the app does (env → .env files) ───────
let KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
if (!KEY) {
  for (const f of [".env", ".env.local", ".env.production"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^ANTHROPIC_API_KEY=(.*)$/m);
    if (m) { KEY = m[1].trim().replace(/^["']|["']$/g, ""); break; }
  }
}
if (!KEY) { console.error("❌ No ANTHROPIC_API_KEY in env or .env files."); process.exit(1); }
console.log(`key: ${KEY.slice(0, 14)}…${KEY.slice(-4)} (${KEY.length} chars)\n`);

const H = { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };

// ── 1. What models can this key see at all? ─────────────────────────────
console.log("████ 1. GET /v1/models — models visible to this key ████");
try {
  const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: H });
  const j = await r.json().catch(() => null);
  console.log(`status: ${r.status}   org: ${r.headers.get("anthropic-organization-id") || "?"}`);
  if (r.ok && j?.data) {
    const ids = j.data.map((m) => m.id);
    for (const want of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      const hit = ids.find((id) => id === want || id.startsWith(want));
      console.log(`  ${hit ? "✅" : "❌"} ${want}${hit && hit !== want ? `  (as ${hit})` : ""}`);
    }
    console.log(`  (key sees ${ids.length} models total)`);
  } else {
    console.log(`  body: ${JSON.stringify(j).slice(0, 300)}`);
  }
} catch (e) { console.log(`  ✗ ${e.message}`); }

// ── 2. Tiny real call per model the platform uses ───────────────────────
console.log("\n████ 2. POST /v1/messages — tiny live call per model ████");
const MODELS = [
  ["claude-sonnet-4-6", "synthesis + denial analyst (worked before)"],
  ["claude-opus-4-8", "extractor (the switch under suspicion)"],
  ["claude-haiku-4-5", "query parser"],
];
const results = {};
for (const [model, role] of MODELS) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
    });
    const j = await r.json().catch(() => null);
    const org = r.headers.get("anthropic-organization-id") || "?";
    if (r.ok) {
      const text = j?.content?.[0]?.text ?? "";
      results[model] = "OK";
      console.log(`  ✅ ${model} — ${role}\n     status 200, replied "${text.trim().slice(0, 20)}", in=${j?.usage?.input_tokens} out=${j?.usage?.output_tokens}, org=${org}`);
    } else {
      results[model] = `${r.status} ${j?.error?.type || ""}`;
      console.log(`  ❌ ${model} — ${role}\n     status ${r.status}  type=${j?.error?.type}  org=${org}\n     message: ${String(j?.error?.message || "").slice(0, 160)}`);
    }
  } catch (e) {
    results[model] = e.message;
    console.log(`  ✗ ${model} — network: ${e.message}`);
  }
}

// ── 3. Verdict ──────────────────────────────────────────────────────────
console.log("\n████ VERDICT ████");
const ok = (m) => results[m] === "OK";
if (ok("claude-opus-4-8")) {
  console.log("Opus 4.8 WORKS on this key — the earlier failures were transient or credits have since been topped up. Re-run the chunked ingest.");
} else if (ok("claude-sonnet-4-6") && !ok("claude-opus-4-8")) {
  console.log("Sonnet 4.6 works but Opus 4.8 fails — it IS Opus-specific for this key/org (model access or per-model billing). Fix: switch EXTRACTION_MODEL back to a working model, or resolve Opus access in console.anthropic.com.");
} else if (!ok("claude-sonnet-4-6") && !ok("claude-opus-4-8") && !ok("claude-haiku-4-5")) {
  console.log("ALL models fail — this key's ORG is out of credits or capped (see the org id above; make sure the credits you see in console.anthropic.com belong to THAT org, and check Settings → Limits for a monthly spend cap).");
} else {
  console.log("Mixed results — see per-model errors above.");
}
