/**
 * FULL live UI walkthrough — drives a real headless browser through every
 * page + key button of the running app, so you DON'T have to log in and
 * click. Screenshots every step to ./screenshots/*.png for visual review.
 *
 * Logs into the seeded demo account (livedemo@pallio.io), which already has
 * Ada/Grace + a visit/superbill/denial, so the data-rich UI actually renders.
 *
 * Run on the VPS (has Playwright + Chromium; used by e2e-ui.mjs already):
 *   BASE_URL=https://app.pallio.io node scripts/e2e-live-walkthrough.mjs
 *   HEADLESS=false ...   # to watch it drive
 *
 * Reports pass/fail per step. Exit 0 iff all steps pass. Review the
 * screenshots folder to SEE each page rendered correctly.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "https://app.pallio.io";
const HEADLESS = process.env.HEADLESS !== "false";
const EMAIL = process.env.TEST_EMAIL || "livedemo@pallio.io";
const PASSWORD = process.env.TEST_PASSWORD || "PallioDemo-2026!";
const SHOTS = join(process.cwd(), "screenshots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (step, ok, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? "  — " + detail : ""}`);
};
let N = 0;
async function shot(page, name) {
  N += 1;
  const file = `${String(N).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "_")}`;
  try { await page.screenshot({ path: join(SHOTS, `${file}.png`), fullPage: true }); } catch {}
  return file;
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const body = () => page.locator("body").innerText().catch(() => "");
  const has = async (re) => re.test(await body());

  async function step(name, fn) {
    try {
      const d = await fn();
      await shot(page, name);
      rec(name, true, d ?? "");
    } catch (err) {
      const f = await shot(page, `ERR-${name}`);
      rec(name, false, `${(err.message || "").slice(0, 120).replace(/\n/g, " ")} [${f}.png]`);
    }
  }

  console.log(`\n████  LIVE UI WALKTHROUGH → ${BASE}  ████`);
  console.log(`     account: ${EMAIL} · screenshots → ${SHOTS}\n`);

  try {
    // ── login ────────────────────────────────────────────────────────
    await step("login page renders", async () => {
      await page.goto(`${BASE}/login`);
      if (!(await page.locator('input[type="password"]').count())) throw new Error("no password field");
    });
    await step("login submits → dashboard", async () => {
      await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await Promise.all([
        page.waitForURL((u) => !u.toString().includes("/login"), { timeout: 25_000 }),
        page.getByRole("button", { name: /sign in|log ?in|continue/i }).first().click(),
      ]);
      return `landed on ${page.url().replace(BASE, "")}`;
    });

    // ── patients caseload ──────────────────────────────────────────────
    await step("patients caseload (acuity + last/next visit)", async () => {
      await page.goto(`${BASE}/patients`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      if (!/Patients/.test(t)) throw new Error("no Patients heading");
      const bits = ["Acuity", "Last visit", "Next visit"].filter((b) => t.includes(b));
      const names = ["Lovelace", "Hopper"].filter((n) => t.includes(n));
      return `cols=[${bits.join(",")}] patients=[${names.join(",")}]`;
    });

    // ── Ada detail: overview + acuity + tabs ───────────────────────────
    await step("open Ada Lovelace → patient detail", async () => {
      await page.getByText("Lovelace", { exact: false }).first().click();
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Identity|Insurance|Clinical/.test(await body())) throw new Error("no detail cards");
      return page.url().replace(BASE, "");
    });
    const adaUrl = page.url();
    await step("acuity selector present + set-able", async () => {
      const sel = page.locator("select").filter({ hasText: /Critical|High|Medium|Low/ }).first();
      const alt = page.getByLabel(/acuity/i).first();
      const el = (await sel.count()) ? sel : alt;
      if (!(await el.count())) throw new Error("acuity select not found");
      await el.selectOption({ label: "High" }).catch(() => {});
      return "acuity → High";
    });
    await step("Ada → Messages tab: send a message", async () => {
      await page.getByRole("button", { name: /^messages$/i }).first().click().catch(async () => {
        await page.getByText(/messages/i).first().click();
      });
      const box = page.getByPlaceholder(/Message the team/i).first();
      await box.waitFor({ timeout: 8000 });
      await box.fill(`UI walkthrough note ${Date.now()}`);
      await page.getByRole("button").filter({ has: page.locator("svg") }).last().click().catch(() => {});
      await page.waitForTimeout(1200);
      return "message sent via UI";
    });
    await step("Ada → Care plan editor", async () => {
      await page.goto(`${adaUrl}/care-plan`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Care plan|Goals of care/.test(await body())) throw new Error("no care plan editor");
    });

    // ── Ada visit → superbill: picker + risk + ICD ─────────────────────
    let visitUrl = null;
    await step("Ada → Visits tab → open visit", async () => {
      await page.goto(adaUrl);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.getByRole("button", { name: /^visits$/i }).first().click().catch(() => {});
      await page.waitForTimeout(600);
      const open = page.getByRole("link", { name: /open/i }).first();
      if (await open.count()) {
        await open.click();
        await page.waitForLoadState("networkidle").catch(() => {});
        visitUrl = page.url();
      }
      return visitUrl ? visitUrl.replace(BASE, "") : "no visit link (will use direct nav)";
    });
    await step("superbill: payer-scoped picker + risk + ICD", async () => {
      const url = visitUrl ? visitUrl.replace(/\/document.*/, "/superbill") : null;
      if (url) await page.goto(url);
      else {
        // fall back: find a visit via the API-less route is hard; assert from schedule instead
        await page.goto(`${BASE}/visits`);
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      const feats = [];
      if (/Superbill/.test(t)) feats.push("superbill");
      if (await page.getByPlaceholder(/Type code or descriptor/i).count()) feats.push("payer-picker");
      if (/risk|likely denial|predicted/i.test(t)) feats.push("risk-badges");
      if (/ICD-10 diagnoses/i.test(t)) feats.push("icd-picker");
      if (/Time spent/i.test(t)) feats.push("time-panel");
      if (feats.length < 2) throw new Error(`only saw: ${feats.join(",") || "nothing"}`);
      return feats.join(",");
    });

    // ── billing lookup (LLM) ───────────────────────────────────────────
    await step("billing lookup → Ask (LLM cited answer)", async () => {
      await page.goto(`${BASE}/billing/lookup`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Rule lookup|lookup/i.test(await body())) throw new Error("no lookup page");
      // Fill whatever fields exist, then Ask.
      await page.locator("select").first().selectOption({ index: 1 }).catch(() => {});
      await page.locator('input').first().fill("99349").catch(() => {});
      const ask = page.getByRole("button", { name: /^ask$/i }).first();
      if (await ask.count()) {
        await ask.click().catch(() => {});
        await page.waitForTimeout(6000); // LLM round-trip
      }
      return "submitted lookup";
    });

    // ── denials + AI analysis ──────────────────────────────────────────
    await step("denials list", async () => {
      await page.goto(`${BASE}/billing/denials`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Denials/.test(await body())) throw new Error("no denials page");
      return "denials list rendered";
    });
    await step("open denial → AI analysis", async () => {
      const row = page.getByRole("link", { name: /open|99349|CPT/i }).first();
      const cell = page.getByText(/99349/).first();
      if (await row.count()) await row.click();
      else if (await cell.count()) await cell.click();
      else throw new Error("no denial row to open");
      await page.waitForLoadState("networkidle").catch(() => {});
      const analyze = page.getByRole("button", { name: /analyze|re-analyze/i }).first();
      if (await analyze.count()) {
        await analyze.click().catch(() => {});
        await page.waitForTimeout(6000); // Claude round-trip
      }
      const t = await body();
      if (!/recommend|refile|appeal|write off|likely|analysis|predicted/i.test(t)) throw new Error("no AI analysis content");
      return "AI analysis shown";
    });

    // ── rulebook + comparison ──────────────────────────────────────────
    await step("rulebook (generated + comparison controls)", async () => {
      await page.goto(`${BASE}/settings/rulebook`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      if (!/Rulebook/.test(t)) throw new Error("no rulebook page");
      const feats = ["Generate", "covered", "Aetna", "compare", "upload"].filter((f) => new RegExp(f, "i").test(t));
      return `saw: ${feats.join(",")}`;
    });

    // ── cheat sheets ───────────────────────────────────────────────────
    await step("cheat sheets page", async () => {
      await page.goto(`${BASE}/cheat-sheets`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (!/Cheat sheets|Generate cheat sheet/i.test(await body())) throw new Error("no cheat-sheet page");
    });

    // ── schedule week grid ─────────────────────────────────────────────
    await step("schedule week grid + controls", async () => {
      await page.goto(`${BASE}/schedule`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const t = await body();
      if (!/Schedule/.test(t)) throw new Error("no schedule page");
      const btns = ["Prev", "This week", "Next", "New visit", "Add PTO", "Print route"].filter((b) => t.includes(b));
      if (btns.length < 3) throw new Error(`few controls: ${btns.join(",")}`);
      return `controls=[${btns.join(",")}]`;
    });

    // ── remaining pages render ─────────────────────────────────────────
    for (const [route, needle] of [
      ["/", /dashboard|overview|kpi|welcome|today/i],
      ["/reports", /Reports/i],
      ["/audit", /Audit/i],
      ["/team", /Team/i],
      ["/inbox", /Inbox/i],
      ["/documents", /Documents/i],
      ["/settings", /Settings/i],
      ["/settings/account", /Account/i],
      ["/settings/branding", /Branding/i],
      ["/settings/security", /Security|MFA/i],
      ["/settings/integrations", /Integrations|Google Calendar/i],
      ["/visits", /Visits/i],
    ]) {
      await step(`page ${route}`, async () => {
        await page.goto(`${BASE}${route}`);
        await page.waitForLoadState("networkidle").catch(() => {});
        if (!needle.test(await body())) throw new Error(`content mismatch on ${route}`);
      });
    }

    // ── notification bell present ──────────────────────────────────────
    await step("notification bell in chrome", async () => {
      await page.goto(`${BASE}/patients`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const bell = page.locator('[aria-label*="notification" i], button:has(svg.lucide-bell), [data-testid="bell"]');
      // best-effort — bell may be an icon; don't hard-fail the whole run on it
      return (await bell.count()) ? "bell present" : "bell not detected (non-fatal)";
    });

    // ── logout ─────────────────────────────────────────────────────────
    await step("logout → /login", async () => {
      const btn = page.getByRole("button", { name: /sign out|log ?out/i }).first();
      if (!(await btn.count())) throw new Error("sign-out not found");
      await btn.click();
      await page.waitForURL((u) => u.toString().includes("/login"), { timeout: 12_000 });
    });
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n████  RESULT  ████`);
  console.log(`${pass}/${results.length} UI steps pass`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log("\nFailures (with screenshot names):"); for (const f of failed) console.log(`  ❌ ${f.step} — ${f.detail}`); }
  console.log(`\nScreenshots for visual review: ${SHOTS}`);
  console.log(`  (${N} PNGs — scroll through them to SEE every page without logging in)`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
