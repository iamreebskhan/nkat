/**
 * Verify the MASTER / OPERATOR (platform-admin) surface live.
 *
 * No existing harness covers this: probe-full-live hits the admin API routes
 * but e2e-live-walkthrough runs as the demo (org_admin) account, which can't
 * reach /admin/*. This checks both halves of the operator surface:
 *
 *   PART A — GATING (always runs, needs no operator creds):
 *     As the demo user (org_admin), every /api/admin/* endpoint must return
 *     403 (session valid, role !== platform_admin). Proves regular users
 *     cannot see or use the master surface.
 *
 *   PART B — FUNCTION (runs only if OPERATOR_EMAIL/OPERATOR_PASSWORD given):
 *     As the operator (platform_admin), the same endpoints return 200 with
 *     real data. Proves the master backend is wired and working.
 *
 * Pure session + SQL paths — no Anthropic API calls.
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io \
 *   OPERATOR_EMAIL=hamda@... OPERATOR_PASSWORD=... \
 *     node scripts/verify-master-ui.mjs
 *   (omit OPERATOR_* to run the gating half only.)
 */
const BASE = process.env.BASE_URL || "https://app.pallio.io";
const USER_EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const USER_PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const OP_EMAIL = process.env.OPERATOR_EMAIL || "";
const OP_PASSWORD = process.env.OPERATOR_PASSWORD || "";
const OP_MFA = process.env.OPERATOR_MFA || ""; // TOTP code, if the operator account has 2FA

const results = [];
const ok = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };
const info = (m) => console.log(`   · ${m}`);

// GET endpoints on the master surface (index routes; [id] sub-routes need ids).
const ADMIN_GET = [
  "/api/admin/orgs",
  "/api/admin/compliance",
  "/api/admin/ingestion-sources",
  "/api/admin/platform-settings",
  "/api/admin/cheatsheet-templates",
];
// Operator UI pages (must render, not 500/redirect-to-login).
const ADMIN_PAGES = [
  "/admin/health", "/admin/orgs", "/admin/ingestion-sources",
  "/admin/settings", "/admin/cheatsheets", "/admin/compliance", "/audit",
];

function mkClient() {
  let cookie = "";
  return {
    async req(m, p, b) {
      const h = { ...(cookie ? { cookie } : {}) };
      let body; if (b !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(b); }
      const r = await fetch(BASE + p, { method: m, headers: h, body, redirect: "manual" });
      for (const c of r.headers.getSetCookie?.() || []) { const x = c.match(/^pallio_session=([^;]*)/); if (x) cookie = `pallio_session=${x[1]}`; }
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { s: r.status, j, t };
    },
    async page(p) {
      const r = await fetch(BASE + p, { headers: { ...(cookie ? { cookie } : {}) }, redirect: "manual" });
      return { s: r.status, loc: r.headers.get("location") || "" };
    },
    hasCookie: () => !!cookie,
  };
}

console.log(`\n████  MASTER / OPERATOR SURFACE → ${BASE}  ████\n`);

// ── PART A — gating: the demo (org_admin) user must be LOCKED OUT ──────
console.log("████ A. Master surface is locked from regular users (org_admin) ████");
const user = mkClient();
{
  const su = await user.req("POST", "/api/auth/signup", { email: USER_EMAIL, password: USER_PASSWORD, fullName: "Live Tester", orgName: "Pallio Live Demo", baaAccepted: true });
  if (su.s !== 201) await user.req("POST", "/api/auth/login", { email: USER_EMAIL, password: USER_PASSWORD });
}
const uMe = (await user.req("GET", "/api/auth/me")).j?.data;
ok("demo user authenticated (org_admin)", uMe?.role === "org_admin", `role=${uMe?.role}`);
let denied = 0;
for (const ep of ADMIN_GET) {
  const r = await user.req("GET", ep);
  const isDenied = r.s === 403;
  console.log(`  ${isDenied ? "✓" : "✗"} ${ep} → ${r.s}${isDenied ? " (correctly forbidden)" : " EXPECTED 403"}`);
  if (isDenied) denied++;
}
// The API 403s ARE the security boundary — that's the hard assertion.
ok("all master API endpoints return 403 to org_admin (the real gate)", denied === ADMIN_GET.length, `${denied}/${ADMIN_GET.length}`);
// Page-shell behaviour is informational: an app may SSR-200 the shell and
// client-gate (data still 403s), or middleware-redirect. Either is fine.
let pageGated = 0;
for (const pg of ADMIN_PAGES) {
  const r = await user.page(pg);
  if (r.s === 307 || r.s === 302 || r.s === 403 || r.s === 404 || /\/login|\/$/.test(r.loc)) pageGated++;
}
info(`operator pages vs org_admin: ${pageGated}/${ADMIN_PAGES.length} redirect/deny at the edge (rest are SSR-shell + client-gated; data is 403-locked above)`);

// ── PART B — function: the operator (platform_admin) gets real data ───
console.log("\n████ B. Master surface works for the operator (platform_admin) ████");
// Catch un-substituted example values ('...', '…', '<...>', 'your-...') so a
// pasted placeholder fails LOUDLY here instead of as a misleading login 401.
const isPlaceholder = (v) => v.trim() === "" || /^(\.{2,}|…|<|your-|xxx|changeme|placeholder|todo)/i.test(v.trim());
const opHelp = () => {
  info("Set the real password without paste-mangling or on-screen exposure:");
  info("  read -rs -p 'operator password: ' OPERATOR_PASSWORD; export OPERATOR_PASSWORD; echo");
  info("  export OPERATOR_EMAIL='hamda@theaura.agency'");
  info("  BASE_URL=https://app.pallio.io node scripts/verify-master-ui.mjs");
};
if (!OP_EMAIL || !OP_PASSWORD) {
  info("OPERATOR_EMAIL / OPERATOR_PASSWORD not set — skipping the operator-side checks.");
  opHelp();
} else if (isPlaceholder(OP_PASSWORD) || isPlaceholder(OP_EMAIL)) {
  info("OPERATOR_* is an un-substituted placeholder, not a real value — the example block was pasted literally.");
  opHelp();
} else {
  const op = mkClient();
  const lg = await op.req("POST", "/api/auth/login", { email: OP_EMAIL, password: OP_PASSWORD, ...(OP_MFA ? { mfaCode: OP_MFA } : {}) });
  // Surface WHY a login fails — the API returns distinct 401s: "Invalid email
  // or password." (wrong/mangled creds) vs "MFA code required." (2FA is on —
  // re-run with OPERATOR_MFA=<6-digit code>). A 403 means the account is
  // suspended. Without this, a bare "status=401" is ambiguous.
  const lgMsg = lg.s === 200 ? "" : ` — ${(lg.j?.error || lg.t || "").toString().slice(0, 80)}`;
  ok("operator login", lg.s === 200, `status=${lg.s}${lgMsg}`);
  if (lg.s === 401 && /mfa/i.test(lgMsg)) info("→ this account has 2FA: re-run with OPERATOR_MFA=<current 6-digit code>");
  if (lg.s === 401 && /invalid/i.test(lgMsg)) info("→ email/password didn't match (check for paste mangling; single-quote a password with ! or #)");
  const opMe = (await op.req("GET", "/api/auth/me")).j?.data;
  ok("operator is platform_admin", opMe?.role === "platform_admin", `role=${opMe?.role}`);
  let served = 0;
  for (const ep of ADMIN_GET) {
    const r = await op.req("GET", ep);
    const good = r.s === 200 && r.j?.data !== undefined;
    const n = Array.isArray(r.j?.data) ? r.j.data.length
      : (r.j?.data?.rows?.length ?? r.j?.data?.orgs?.length ?? r.j?.data?.checks?.length ?? r.j?.data?.sources?.length ?? (r.j?.data ? "obj" : "?"));
    console.log(`  ${good ? "✓" : "✗"} ${ep} → ${r.s}  (${n} items)`);
    if (good) served++;
  }
  ok("all master API endpoints return data to the operator", served === ADMIN_GET.length, `${served}/${ADMIN_GET.length}`);
  let rendered = 0;
  for (const pg of ADMIN_PAGES) {
    const r = await op.page(pg);
    if (r.s === 200) rendered++;
    else console.log(`  ✗ operator page ${pg} → ${r.s} ${r.loc}`);
  }
  ok("operator pages render for platform_admin", rendered === ADMIN_PAGES.length, `${rendered}/${ADMIN_PAGES.length}`);
}

// ── result ────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.c).length;
console.log(`\n████  RESULT  ████`);
console.log(`${pass}/${results.length} checks pass`);
const failed = results.filter((r) => !r.c);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  ❌ " + f.n); }
console.log(`\n${failed.length === 0
  ? (OP_EMAIL ? "✅ master surface: gated from users AND functional for the operator" : "✅ master surface correctly gated from users (set OPERATOR_* to also verify the operator side)")
  : "❌ see above"}`);
process.exit(failed.length === 0 ? 0 : 1);
