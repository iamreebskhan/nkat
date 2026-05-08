import { expect, test } from '@playwright/test';

test('login page renders + redirects unauthenticated requests', async ({ page }) => {
  await page.goto('/lookup');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('dev-header sign-in routes to lookup', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Org ID (UUID)').fill('11111111-1111-4111-8111-111111111111');
  await page.getByLabel('User ID (UUID)').fill('22222222-2222-4222-8222-222222222222');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/lookup/);
  await expect(page.getByRole('heading', { name: 'Lookup' })).toBeVisible();
});

test('rejects malformed UUIDs', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Org ID (UUID)').fill('not-a-uuid');
  await page.getByLabel('User ID (UUID)').fill('also-not');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').first()).toContainText('Invalid UUID');
});
