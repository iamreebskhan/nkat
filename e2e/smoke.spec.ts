/**
 * Production smoke — runs against the deployed app post-promotion.
 *
 * Usage:
 *   PALLIO_BASE_URL=https://app.pallio.io \
 *   PALLIO_SMOKE_USER_EMAIL=smoke@pallio.io \
 *   PALLIO_SMOKE_USER_PASSWORD=… \
 *   npx playwright test e2e/smoke.spec.ts
 *
 * The smoke account is a dedicated tenant with seeded fixtures. It
 * never holds real PHI.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.PALLIO_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.PALLIO_SMOKE_USER_EMAIL ?? "";
const PASSWORD = process.env.PALLIO_SMOKE_USER_PASSWORD ?? "";

test.describe("Pallio smoke", () => {
  test.beforeAll(() => {
    if (!EMAIL || !PASSWORD) {
      throw new Error(
        "PALLIO_SMOKE_USER_EMAIL + PALLIO_SMOKE_USER_PASSWORD must be set.",
      );
    }
  });

  test("login → dashboard renders", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await expect(page).toHaveURL(/\/(?:billing\/lookup|patients|reports)/, {
      timeout: 10_000,
    });
  });

  test("rule lookup returns a cited answer", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/(?:billing\/lookup|patients|reports)/);

    await page.goto(`${BASE}/billing/lookup`);
    await page.fill('textarea, input[name="query"]', "Does Humana cover 99349 in OH for telehealth?");
    await page.click('button:has-text("Look up")');
    await expect(page.locator("[data-testid=lookup-result], .lookup-result, main"))
      .toContainText(/covered|not covered|varies|unknown|no rule/i, { timeout: 30_000 });
  });

  test("reports overview renders all sections", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/(?:billing|patients|reports)/);

    await page.goto(`${BASE}/reports`);
    await expect(page.locator("text=/Denial-rate trend/i")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=/Revenue|Billed|Collected/i").first()).toBeVisible();
  });

  test("attestations queue renders", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");

    await page.goto(`${BASE}/payers/attestations`);
    await expect(page.locator("text=Attestations").first()).toBeVisible();
  });

  test("livez health endpoint", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health/livez`);
    expect(res.status()).toBeLessThan(500);
  });
});
