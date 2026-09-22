import {type Page, expect, test} from '@playwright/test';

const FIXTURE = '/e2e/fixtures/focus-trap.html';
const OUTSIDE = ['outside-before', 'open-outer', 'outside-after'];

async function focusedId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__focusedId());
}

async function tabCycle(page: Page, key: 'Tab' | 'Shift+Tab', max = 16): Promise<string[]> {
  const start = await focusedId(page);
  const seen: string[] = [];

  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press(key);

    const id = await focusedId(page);

    if (id === start) {
      return seen;
    }

    seen.push(id ?? '(none)');
  }

  throw new Error(`focus did not cycle back to ${start}; saw ${seen.join(', ')}`);
}

test.beforeEach(async ({page}) => {
  await page.goto(FIXTURE);
  await page.waitForSelector('html[data-ready="true"]');
  await page.click('#open-outer');
});

test('moves initial focus into the trap', async ({page}) => {
  await expect.poll(() => focusedId(page)).toBe('outer-first');
});

test('Tab cycles through native, custom-element, shadow, and slotted controls without escaping', async ({page}) => {
  const forward = await tabCycle(page, 'Tab');

  expect(forward.some((id) => OUTSIDE.includes(id))).toBe(false);
  expect(forward).toContain('outer-input');
  expect(forward).toContain('outer-last');

  const order = ['shadow-before', 'slotted', 'shadow-after'].map((id) => forward.indexOf(id));

  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test('Shift+Tab from the first control wraps to the last', async ({page}) => {
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => focusedId(page)).toBe('outer-last');
});

test('a click outside returns focus to the last focused control in the trap', async ({page}) => {
  await page.keyboard.press('Tab');

  const lastInside = await focusedId(page);

  expect(lastInside).not.toBe('outer-first');

  await page.click('#outside-after');
  await expect.poll(() => focusedId(page)).toBe(lastInside);
});

test('nested traps pause the outer trap and restore focus when closed', async ({page}) => {
  await page.click('#open-inner');
  await expect.poll(() => focusedId(page)).toBe('inner-first');

  expect(await tabCycle(page, 'Tab')).toEqual(['inner-last']);

  await page.click('#outer-first');
  await expect.poll(() => focusedId(page)).toBe('inner-first');

  await page.keyboard.press('Escape');
  await expect.poll(() => focusedId(page)).toBe('open-inner');

  const outer = await tabCycle(page, 'Tab');

  expect(outer.some((id) => OUTSIDE.includes(id) || id.startsWith('inner-'))).toBe(false);

  await page.keyboard.press('Escape');
  await expect.poll(() => focusedId(page)).toBe('open-outer');
});
