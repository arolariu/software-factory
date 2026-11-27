import { expect, test } from '@playwright/test';

test('serves the signed-out shell at a direct link without fixtures or horizontal overflow', async ({ page }) => {
  const response = await page.goto('/connections/example/issues');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Software Factory' })).toBeVisible();
  await expect(page.getByText('Signed out. Use Setup and settings to sign in.')).toBeVisible();
  const setup = page.getByRole('link', { name: 'Setup and settings' });
  await setup.focus();
  await expect(setup).toBeFocused();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Welcome to Vite');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
