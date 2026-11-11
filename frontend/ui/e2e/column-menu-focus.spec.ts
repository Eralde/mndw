import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.goto('/e2e/fixtures/components.html');
});

test('column menu returns focus to trigger after Escape', async ({page}) => {
  const trigger = page.locator('#table-fixture [part="column-menu-trigger"]');
  const menu = page.locator('mndw-column-menu');

  await trigger.click();
  await expect(menu.locator('button[data-column-id="model"]')).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('column menu returns focus after API close when focus was inside', async ({page}) => {
  const trigger = page.locator('#table-fixture [part="column-menu-trigger"]');
  const menu = page.locator('mndw-column-menu');

  await trigger.click();
  await expect(menu.locator('button[data-column-id="model"]')).toBeFocused();

  await menu.evaluate((element) => {
    element.dispatchEvent(new CustomEvent('mndwpaneldismiss', {
      bubbles: true,
      composed: true,
      detail: {restoreFocus: false},
    }));
  });

  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('column menu outside pointer close leaves focus on clicked target', async ({page}) => {
  await page.evaluate(() => {
    const button = document.createElement('button');

    button.id = 'outside-focus-target';
    button.textContent = 'Outside';
    button.style.position = 'fixed';
    button.style.left = '2px';
    button.style.top = '2px';
    document.body.append(button);
  });

  const trigger = page.locator('#table-fixture [part="column-menu-trigger"]');
  const menu = page.locator('mndw-column-menu');
  const outside = page.locator('#outside-focus-target');

  await trigger.click();
  await expect(menu.locator('button[data-column-id="model"]')).toBeFocused();
  await outside.click();

  await expect(menu).toHaveCount(0);
  await expect(outside).toBeFocused();
  await expect(trigger).not.toBeFocused();
});
