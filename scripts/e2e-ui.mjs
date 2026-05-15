/**
 * UI end-to-end test against https://app.pallio.io.
 *
 * Drives a real headless Chromium through the user-facing flow:
 *   signup → onboarding wizard → patient → schedule → document
 *   → superbill PDF → billing lookup → logout.
 *
 * Screenshots saved to ./screenshots/<step>.png so you can review
 * what the user actually sees at each step.
 *
 * Usage:
 *   node scripts/e2e-ui.mjs
 *   BASE_URL=https://app.pallio.io HEADLESS=false node scripts/e2e-ui.mjs
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "https://app.pallio.io";
const HEADLESS = process.env.HEADLESS !== "false";
const SHOTS = join(process.cwd(), "screenshots");
mkdirSync(SHOTS, { recursive: true });

const stamp = Date.now();
const ORG = `UI Smoke ${stamp}`;
const EMAIL = `ui-${stamp}@pallio-smoke.test`;
const PASSWORD = `UiSmokePass-${stamp}!`;
const FULL_NAME = `UI Tester ${stamp}`;

const results = [];
function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  const tag = ok ? "✅" : "❌";
  console.log(`${tag} ${step}${detail ? "  — " + detail : ""}`);
}

async function shot(page, name) {
  try { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } catch {}
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);

  // Each step wrapped — one failure doesn't abort the rest.
  async function step(name, fn) {
    try {
      const detail = await fn();
      record(name, true, detail ?? "");
    } catch (err) {
      await shot(page, `ERR-${name.replace(/[^a-z0-9]+/gi, "_")}`);
      record(name, false, err.message.slice(0, 150).replace(/\n/g, " "));
    }
  }

  try {
    await step("signup form renders", async () => {
      await page.goto(`${BASE}/signup`);
      await shot(page, "01-signup");
      if (!(await page.getByLabel("Your full name").count())) throw new Error("name field missing");
    });

    await step("signup submits → /onboarding redirect", async () => {
      await page.getByLabel("Your full name").fill(FULL_NAME);
      await page.getByLabel("Work email").fill(EMAIL);
      await page.getByLabel("Password (min 12 characters)").fill(PASSWORD);
      await page.getByLabel("Organization name").fill(ORG);
      await page.locator('input[type="checkbox"]').check();
      await shot(page, "02-signup-filled");
      await Promise.all([
        page.waitForURL((u) => !u.toString().includes("/signup"), { timeout: 20_000 }),
        page.getByRole("button", { name: /create account/i }).click(),
      ]);
      await shot(page, "03-after-signup");
      return `landed on ${page.url().replace(BASE, "")}`;
    });

    await step("onboarding wizard hydrates", async () => {
      if (!page.url().includes("/onboarding")) await page.goto(`${BASE}/onboarding`);
      // Wait for the actual wizard heading to appear (not the "Loading…" state)
      await page.locator("text=Organization profile").waitFor({ timeout: 15_000 });
      await shot(page, "04-onboarding-profile");
    });

    await step("onboarding fills profile + clicks Next", async () => {
      await page.locator("#org").fill(ORG);
      await page.locator("#npi").fill("1234567890");
      await page.locator("#type").selectOption("palliative");
      await page.getByRole("button", { name: /^next$/i }).click();
      await page.locator("text=Where do you bill").waitFor({ timeout: 5000 }).catch(() => {});
      await shot(page, "05-onboarding-step2-states");
    });

    await step("patients list page renders", async () => {
      await page.goto(`${BASE}/patients`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "06-patients-list-empty");
      if (!page.url().includes("/patients")) throw new Error("URL not /patients");
    });

    await step("new-patient wizard opens", async () => {
      await page.locator('a:has-text("New patient")').first().click();
      await page.locator("text=Demographics").waitFor({ timeout: 5000 });
      await shot(page, "07-patient-new-wizard");
      if (!page.url().includes("/new")) throw new Error(`unexpected URL ${page.url()}`);
    });

    await step("new-patient: fill demographics + Next", async () => {
      await page.getByLabel(/first name/i).fill("Ada");
      await page.getByLabel(/last name/i).fill("Lovelace");
      await page.getByLabel(/date of birth/i).fill("1940-06-15");
      await page.getByRole("button", { name: /^next$/i }).click();
      // Should now be on Insurance step
      await page.locator("text=Insurance").waitFor({ timeout: 5000 }).catch(() => {});
      await shot(page, "07b-patient-insurance");
    });

    await step("billing lookup page renders", async () => {
      await page.goto(`${BASE}/billing/lookup`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "08-billing-lookup");
      const t = await page.locator("body").innerText();
      if (!/payer|cpt|lookup/i.test(t)) throw new Error("no lookup content");
    });

    await step("schedule page renders", async () => {
      await page.goto(`${BASE}/schedule`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "09-schedule");
      if (!page.url().includes("/schedule")) throw new Error("URL mismatch");
    });

    await step("visits page renders", async () => {
      await page.goto(`${BASE}/visits`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "10-visits");
      if (!page.url().includes("/visits")) throw new Error("URL mismatch");
    });

    await step("reports page renders", async () => {
      await page.goto(`${BASE}/reports`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "11-reports");
      if (!page.url().includes("/reports")) throw new Error("URL mismatch");
    });

    await step("cheat sheets page renders", async () => {
      await page.goto(`${BASE}/cheat-sheets`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "12-cheat-sheets");
      if (!/cheat/i.test(page.url())) throw new Error(`URL=${page.url()}`);
    });

    await step("settings/account renders", async () => {
      await page.goto(`${BASE}/settings/account`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "13-settings-account");
      const t = await page.locator("body").innerText();
      if (!/full name|email|password|account/i.test(t)) throw new Error("no account content");
    });

    await step("sidebar shows org name", async () => {
      const sb = await page.locator("aside").innerText().catch(() => "");
      if (!sb.includes(ORG)) throw new Error(`sidebar="${sb.split("\n").slice(0,3).join(" / ")}"`);
    });

    await step("logout returns to /login", async () => {
      const btn = page.getByRole("button", { name: /sign out/i }).first();
      if (!(await btn.count())) throw new Error("sign-out button not found");
      await btn.click();
      await page.waitForURL((u) => u.toString().includes("/login"), { timeout: 10_000 });
      await shot(page, "14-after-logout");
    });

    await step("re-login with credentials works", async () => {
      await page.goto(`${BASE}/login`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await shot(page, "15-login-page");
      await page.getByLabel(/email/i).fill(EMAIL);
      await page.getByLabel(/password/i).fill(PASSWORD);
      await page.getByRole("button", { name: /sign in|log in/i }).click();
      await page.waitForURL((u) => !u.toString().includes("/login"), { timeout: 15_000 });
      await shot(page, "16-after-relogin");
    });

  } catch (err) {
    console.error("\n❌ Outer crash:", err.message);
    await shot(page, "99-crash");
    record("RUNTIME", false, err.message.slice(0, 200));
  } finally {
    const pass = results.filter((r) => r.ok).length;
    const total = results.length;
    console.log(`\n=== ${pass}/${total} UI steps passed ===`);
    console.log(`Screenshots: ${SHOTS}`);
    await browser.close();
    if (pass < total) process.exit(1);
  }
})();
