import {expect, test} from '@playwright/test';

test('home page loads under the base path', async ({page}) => {
  const response = await page.goto('');
  const heroName = page.locator('.home-hero__name');

  expect(response?.status()).toBe(200);
  await expect(heroName).toBeVisible();
  await expect(heroName).toContainText('mndw');
});
