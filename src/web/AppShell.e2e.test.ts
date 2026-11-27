import { expect, test } from '@playwright/test';

test('serves the signed-out shell at a direct link without fixtures or horizontal overflow', async ({ page }) => {
  const response = await page.goto('/connections/example/issues');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('navigation', { name: 'Factory' }).getByRole('link', { name: 'Repositories' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Software Factory' })).toBeVisible();
  await expect(page.getByText('Signed out. Use Setup and settings to sign in.')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  const setup = page.getByRole('link', { name: 'Setup and settings' });
  await setup.focus();
  await expect(setup).toBeFocused();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Welcome to Vite');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
