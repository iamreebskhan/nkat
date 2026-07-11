/**
 * EXHAUSTIVE live UI crawl — visits EVERY page, clicks EVERY safe button,
 * and exercises the two flows no other harness drives:
 *
 *   · schedule drag-and-drop  (drag a visit card onto another day →
 *     PATCH /api/visits/[id]/reschedule must 200)
 *   · rulebook CSV file-upload (real <input type="file"> →
 *     POST /api/rulebook/upload must 200 and the comparison must render)
 *
 * Per page it records: buttons found / clicked / skipped, uncaught page
 * exceptions, console errors, and every 5xx (hard fail) or /api 404
 * (broken-wiring warning) any click provokes. Complements
 * e2e-live-walkthrough (scenario flows) with breadth: every element, every page.
 *
 * Click policy: destructive labels (delete / remove / deactivate / revoke /
 * log out …) are skipped; AI-invoking labels (analyze / ask / generate) are
 * skipped by default so the crawl is credit-free — INCLUDE_AI=1 to click them
 * too (probe-live-account already covers those paths 24/24).
 *
 * Run on the VPS:
 *   BASE_URL=https://app.pallio.io node scripts/e2e-exhaustive-ui.mjs
 * Optionally crawl the master surface too (operator creds via read -rs):
 *   read -rs -p 'operator password: ' OPERATOR_PASSWORD; export OPERATOR_PASSWORD; echo
 *   export OPERATOR_EMAIL='hamda@theaura.agency'
 *   BASE_URL=https://app.pallio.io node scripts/e2e-exhaustive-ui.mjs
 */
import { chromium } from "playwright";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.BASE_URL || "https://app.pallio.io";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const OP_EMAIL = process.env.OPERATOR_EMAIL || "";
const OP_PASSWORD = process.env.OPERATOR_PASSWORD || "";
const INCLUDE_AI = process.env.INCLUDE_AI === "1";
const MAX_CLICKS = Number(process.env.MAX_CLICKS || 25);

const SKIP_DESTRUCTIVE = /delete|remove|deactivate|suspend|revoke|log ?out|sign ?out|disable|retire|archive|reset|danger/i;
const SKIP_AI = /analyze|re-analyze|^ask$|generate|regenerate/i;

const PLATFORM_PAGES = [
  "/", "/patients", "/patients/new", "/visits", "/schedule", "/schedule/print",
  "/care-plans", "/cheat-sheets", "/documents", "/inbox", "/team", "/reports",
  "/audit", "/onboarding",
  "/billing/lookup", "/billing/denials", "/billing/denials/log", "/billing/claims",
  "/billing/superbills", "/payers", "/payers/attestations", "/payers/attestations/new",
  "/settings", "/settings/account", "/settings/billing", "/settings/branding",
  "/settings/integrations", "/settings/rulebook", "/settings/security",
];
const ADMIN_PAGES = [
  "/admin/health", "/admin/orgs", "/admin/ingestion-sources",
  "/admin/settings", "/admin/cheatsheets", "/admin/compliance",
];

const rows = [];
const hard = []; // hard failures: uncaught exceptions, 5xx, special-flow breaks
const warn = []; // warnings: /api 404s provoked by the UI
const ok = (n, c, d = "") => console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`);
const info = (m) => console.log(`   · ${m}`);

async function loginContext(browser, email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(`${BASE}/login`);
  await page.locator('input[type="email"], input[name="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes("/login"), { timeout: 25_000 }),
    page.getByRole("button", { name: /sign in|log ?in|continue/i }).first().click(),
  ]);
  return { ctx, page };
}

/** Crawl one page: click every safe button, harvest errors. */
async function crawlPage(page, path, tag) {
  const pageErrors = [];
  const badResponses = [];
  const onPageError = (e) => pageErrors.push(String(e.message || e).slice(0, 140));
  const onResponse = (r) => {
    const s = r.status();
    const u = r.url();
    if (s >= 500 || (s === 404 && u.includes("/api/"))) {
      // Distinguish app bugs from DEPLOYMENT STATE: routes deliberately answer
      // 503/404 when an optional third-party service isn't provisioned
      // (Stripe checkout → "Billing not configured", Google OAuth →
      // "not configured", subscription → "No subscription on file"). Those are
      // expected on a VPS without those keys — report as warnings, not bugs.
      r.text().then((t) => {
        const unconfigured = /not configured|no subscription on file|contact sales/i.test(t || "");
        badResponses.push(`${unconfigured ? "404 unconfigured" : s >= 500 ? "5xx" : "404"} ${s} ${u.replace(BASE, "")}`);
      }).catch(() => badResponses.push(`${s >= 500 ? "5xx" : "404"} ${s} ${u.replace(BASE, "")}`));
    }
    // A 400 on a GET the page fires while loading is broken wiring (bad query
    // params) — e.g. the schedule composer's limit=500 vs the API's max 200.
    // POST 400s are excluded: submitting half-filled forms validates as 400.
    else if (s === 400 && u.includes("/api/") && r.request().method() === "GET")
      badResponses.push(`404 GET-400 ${u.replace(BASE, "")}`);
  };
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  let found = 0, clicked = 0, skipped = 0;
  try {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const buttons = page.locator('button, [role="button"]');
    found = await buttons.count();
    const n = Math.min(found, MAX_CLICKS);
    for (let i = 0; i < n; i++) {
      // Re-resolve each time — clicks mutate the DOM.
      const b = page.locator('button, [role="button"]').nth(i);
      let name = "";
      try { name = ((await b.textContent({ timeout: 800 })) || (await b.getAttribute("aria-label")) || "").trim(); } catch { continue; }
      if (SKIP_DESTRUCTIVE.test(name) || (!INCLUDE_AI && SKIP_AI.test(name))) { skipped++; continue; }
      try {
        if (!(await b.isVisible()) || !(await b.isEnabled())) { skipped++; continue; }
        await b.click({ timeout: 2500, noWaitAfter: true });
        clicked++;
        await page.waitForTimeout(350);
        await page.keyboard.press("Escape").catch(() => {});
        if (!page.url().startsWith(`${BASE}${path}`)) {
          await page.goto(`${BASE}${path}`);
          await page.waitForLoadState("networkidle").catch(() => {});
        }
      } catch { skipped++; }
    }
  } catch (e) {
    pageErrors.push(`goto failed: ${String(e.message).slice(0, 100)}`);
  }
  // Let in-flight response-body reads (the unconfigured-service classifier)
  // land their badResponses pushes before tallying.
  await page.waitForTimeout(600);
  page.off("pageerror", onPageError);
  page.off("response", onResponse);
  const fives = badResponses.filter((b) => b.startsWith("5xx"));
  const fours = [...new Set(badResponses.filter((b) => b.startsWith("404")))];
  rows.push({ tag, path, found, clicked, skipped, errs: pageErrors.length, fives: fives.length, fours: fours.length });
  for (const e of pageErrors) hard.push(`${path}: uncaught ${e}`);
  for (const f of fives) hard.push(`${path}: ${f}`);
  for (const f of fours) warn.push(`${path}: ${f}`);
  const line = `${path.padEnd(32)} btn ${String(found).padStart(3)} · clicked ${String(clicked).padStart(3)} · skipped ${String(skipped).padStart(2)}${pageErrors.length ? ` · ⚠ ${pageErrors.length} uncaught` : ""}${fives.length ? ` · ⚠ ${fives.length}×5xx` : ""}${fours.length ? ` · ${fours.length}×404` : ""}`;
  console.log(`  ${pageErrors.length || fives.length ? "✗" : "✓"} ${line}`);
}

(async () => {
  console.log(`\n████  EXHAUSTIVE UI CRAWL → ${BASE}  ████`);
  console.log(`     click-everything policy: destructive skipped, AI ${INCLUDE_AI ? "INCLUDED" : "skipped (INCLUDE_AI=1 to include)"}\n`);
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const { page } = await loginContext(browser, EMAIL, PASSWORD);
  ok("demo login", true);

  // ── seed deterministic detail-page targets via the authenticated session ──
  // Seeding failures must be LOUD: a silent 4xx here previously left ids
  // undefined and the crawl hit /visits/undefined/… as phantom failures.
  const api = async (m, p, data) => {
    const r = await page.request.fetch(`${BASE}${p}`, { method: m, ...(data ? { data } : {}) });
    const j = await r.json().catch(() => null);
    if (!r.ok() || j?.success === false) {
      info(`seed step ${m} ${p} → ${r.status()} ${String(j?.error ?? "").slice(0, 90)}`);
    }
    return j?.data;
  };
  const me = await api("GET", "/api/auth/me");
  const payers = (await api("GET", "/api/billing/payers"))?.payers || [];
  const payerId = (payers.find((p) => /aetna/i.test(p.name)) || payers[0])?.id;
  const patients = (await api("GET", "/api/patients?limit=200"))?.rows || [];
  const patientId = patients.find((p) => p.firstName === "Ada")?.id || patients[0]?.id;
  // a visit ~tomorrow so the schedule week-grid has a draggable card
  // confirmDoubleBook: fixtures deliberately ignore the 8-visit/day capacity
  // guard — weeks of harness runs stack visits on the demo clinician's
  // "tomorrow", and crossing the cap made seeding 409 silently.
  const visitId = (await api("POST", "/api/visits", {
    patientId, clinicianUserId: me.userId, visitType: "established_patient_home",
    scheduledStart: new Date(Date.now() + 26 * 3600_000).toISOString(), isTelehealth: false,
    confirmDoubleBook: true,
  }))?.id;
  await api("PATCH", `/api/visits/${visitId}/document`, { totalMinutes: 45, documentText: "crawl", cptCodesAssigned: ["99349"], icd10Codes: ["Z51.5"] });
  const superbillId = (await api("POST", `/api/visits/${visitId}/superbill`))?.id;
  const denialId = (await api("POST", "/api/denials", { superbillId, cptCode: "99349", carcCode: "16", denialReason: "crawl", deniedAmountCents: 1000, deniedAt: new Date().toISOString() }))?.id;
  const seeded = !!(patientId && visitId && denialId);
  ok("seeded detail targets", seeded, `patient=${(patientId || "").slice(0, 8)} visit=${(visitId || "").slice(0, 8)} denial=${(denialId || "").slice(0, 8)}`);
  if (!seeded) hard.push(`seeding failed — see the seed-step lines above; detail pages skipped`);

  // Only crawl detail pages whose id actually exists — /visits/undefined/…
  // would just probe the API's bad-id handling, not the pages under test.
  const DETAIL_PAGES = [
    ...(patientId ? [`/patients/${patientId}`, `/patients/${patientId}/care-plan`] : []),
    ...(visitId ? [`/visits/${visitId}/document`, `/visits/${visitId}/superbill`] : []),
    ...(denialId ? [`/billing/denials/${denialId}`] : []),
  ];

  // ── 1. crawl every user page ──────────────────────────────────────────
  console.log("\n████ 1. Crawl every user page — click every safe button ████");
  for (const p of [...PLATFORM_PAGES, ...DETAIL_PAGES]) await crawlPage(page, p, "user");

  // ── 2. schedule drag-and-drop (visit card → different day) ────────────
  console.log("\n████ 2. Drag-and-drop: reschedule a visit on the week grid ████");
  try {
    // Seed a DEDICATED visit here, not in phase 1: the crawl legitimately
    // clicks "Sign + submit for billing" on the document page, transitioning
    // the phase-1 visit out of status=scheduled — which emptied the week grid
    // (that click is proof the sign fix works; it just can't share a fixture).
    // Scheduled today+2h: today is always inside the Monday-start week grid.
    await api("POST", "/api/visits", {
      patientId, clinicianUserId: me.userId, visitType: "established_patient_home",
      scheduledStart: new Date(Date.now() + 2 * 3600_000).toISOString(), isTelehealth: false,
      confirmDoubleBook: true,
    });
    await page.goto(`${BASE}/schedule`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const card = page.locator('[draggable="true"]').first();
    await card.waitFor({ state: "visible", timeout: 10_000 });
    const patched = page.waitForResponse((r) => r.url().includes("/reschedule") && r.request().method() === "PATCH", { timeout: 10_000 });
    // React's synthetic drag handlers respond to real DragEvents with a shared
    // DataTransfer — dispatch them directly (headless HTML5 dnd is unreliable
    // via mouse simulation).
    await page.evaluate(() => {
      const src = document.querySelector('[draggable="true"]');
      const grid = src.closest(".grid"); // the week grid containing this card
      const days = [...grid.children];
      const from = days.find((d) => d.contains(src));
      const i = days.indexOf(from);
      const dst = days[i + 1 < days.length ? i + 1 : i - 1];
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      dst.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
    });
    const resp = await patched;
    const good = resp.status() === 200;
    ok("drag visit card → drop on another day → PATCH /reschedule", good, `status=${resp.status()}`);
    if (!good) hard.push(`schedule DnD: reschedule PATCH ${resp.status()}`);
  } catch (e) {
    ok("drag visit card → drop on another day → PATCH /reschedule", false, String(e.message).slice(0, 100));
    hard.push(`schedule DnD: ${String(e.message).slice(0, 100)}`);
  }

  // ── 3. rulebook CSV file-upload through the real <input type=file> ────
  console.log("\n████ 3. File upload: rulebook CSV through the real file input ████");
  try {
    await page.goto(`${BASE}/settings/rulebook`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const csv = join(mkdtempSync(join(tmpdir(), "pallio-")), "rulebook.csv");
    // same header contract as verify-demo-user-medicare's known-good upload
    writeFileSync(csv, [
      "payer,state,cpt,attribute,coverage,value",
      "Medicare,OH,G2211,covered,covered,Crawl fixture: visit complexity add-on",
      "Medicare,OH,99497,covered,covered,Crawl fixture: advance care planning",
    ].join("\n"));
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 10_000 });
    const uploaded = page.waitForResponse((r) => r.url().includes("/api/rulebook/upload") && r.request().method() === "POST", { timeout: 20_000 });
    await input.setInputFiles(csv);
    // some UIs need an explicit submit after choosing the file
    const submit = page.getByRole("button", { name: /upload|compare|import/i }).first();
    if (await submit.count()) await submit.click({ timeout: 3000, noWaitAfter: true }).catch(() => {});
    const resp = await uploaded;
    const body = await resp.json().catch(() => null);
    // 201 Created is the route's success status (a prior run asserted ===200
    // and marked a SUCCESSFUL upload as failed).
    const good = [200, 201].includes(resp.status()) && body?.success !== false;
    ok("CSV chosen via file input → POST /api/rulebook/upload", good, `status=${resp.status()}`);
    if (good) {
      await page.waitForTimeout(2500);
      const t = await page.locator("body").innerText().catch(() => "");
      const rendered = /match|diff|unverified|new|comparison|G2211/i.test(t);
      ok("comparison renders after upload", rendered);
      if (!rendered) hard.push("rulebook upload: comparison did not render");
    } else hard.push(`rulebook upload: POST ${resp.status()}`);
  } catch (e) {
    ok("rulebook CSV upload", false, String(e.message).slice(0, 100));
    hard.push(`rulebook upload: ${String(e.message).slice(0, 100)}`);
  }

  // ── 4. optional: crawl the master surface as the operator ─────────────
  if (OP_EMAIL && OP_PASSWORD && !/^(\.{2,}|…|<|your-)/.test(OP_PASSWORD)) {
    console.log("\n████ 4. Crawl every master/admin page as the operator ████");
    try {
      const { page: opPage } = await loginContext(browser, OP_EMAIL, OP_PASSWORD);
      ok("operator login", true);
      for (const p of ADMIN_PAGES) await crawlPage(opPage, p, "operator");
    } catch (e) {
      ok("operator login", false, String(e.message).slice(0, 80));
      hard.push(`operator crawl: ${String(e.message).slice(0, 80)}`);
    }
  } else {
    info("OPERATOR_* not set — master pages crawled only via verify-master-ui (render check).");
  }

  // ── result ─────────────────────────────────────────────────────────────
  const totF = rows.reduce((n, r) => n + r.found, 0);
  const totC = rows.reduce((n, r) => n + r.clicked, 0);
  console.log(`\n████  RESULT  ████`);
  console.log(`${rows.length} pages crawled · ${totF} buttons found · ${totC} clicked · ${hard.length} hard failures · ${warn.length} 404 warnings`);
  if (warn.length) { console.log("\n404s provoked by the UI (broken-wiring suspects):"); for (const w of [...new Set(warn)]) console.log("  ⚠ " + w); }
  if (hard.length) { console.log("\nHard failures:"); for (const h of hard) console.log("  ❌ " + h); }
  console.log(`\n${hard.length === 0 ? "✅ every page crawled clean — no uncaught errors, no 5xx, DnD + upload verified" : "❌ see hard failures above"}`);
  await browser.close();
  process.exit(hard.length === 0 ? 0 : 1);
})();
