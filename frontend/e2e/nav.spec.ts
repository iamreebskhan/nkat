import { expect, test } from '@playwright/test';

async function login(page) {
  await page.goto('/login');
  await page.getByLabel('Org ID (UUID)').fill('11111111-1111-4111-8111-111111111111');
  await page.getByLabel('User ID (UUID)').fill('22222222-2222-4222-8222-222222222222');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/lookup/);
}

test('skip-link is the first focusable element', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toContainText('Skip to main content');
});

test('sidebar nav reaches every primary section', async ({ page }) => {
  await login(page);
  for (const [label, urlPart] of [
    ['Reconciliation', '/reconciliation'],
    ['Alerts', '/alerts'],
    ['Denials', '/denials'],
    ['Privacy', '/settings/privacy'],
    ['Audit log', '/admin/audit'],
    ['SCIM tokens', '/admin/scim'],
    ['Rate limits', '/admin/rate-limits'],
    ['Tenant deletion', '/admin/deletion'],
  ] as const) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(urlPart));
  }
});

test('theme is strict B&W — no chromatic accents in primary nav', async ({ page }) => {
  await login(page);
  // Sample the nav active state's computed background.
  const active = page.locator('a[href="/lookup"]').first();
  const bg = await active.evaluate((el) => getComputedStyle(el).backgroundColor);
  // RGB triplet must have R==G==B (greyscale).
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(m).not.toBeNull();
  const [, r, g, b] = m!;
  expect(r).toBe(g);
  expect(g).toBe(b);
});
