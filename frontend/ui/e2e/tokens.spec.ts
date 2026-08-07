import {expect, test} from '@playwright/test';

test('resolves theme aliases against runtime palette overrides', async ({page}) => {
  await page.goto('/e2e/fixtures/tokens.html');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');

  const values = await page.locator('[data-testid="probe"]').evaluate((element) => {
    const style = getComputedStyle(element);

    return {
      shadow: style.boxShadow,
      thumb: style.backgroundColor,
      shadowToken: style.getPropertyValue('--mndw-shadow-2'),
      thumbToken: style.getPropertyValue('--mndw-scrollbar-thumb'),
    };
  });

  expect(values.shadow).toMatch(/10, 20, 30/);
  expect(values.thumb).toMatch(/68, 85, 102/);
  expect(values.shadowToken).toMatch(/10(?:,|\s)+20(?:,|\s)+30/);
  expect(values.thumbToken).toMatch(/68(?:,|\s)+85(?:,|\s)+102/);
});
