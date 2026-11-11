import {type Locator, type Page, expect, test} from '@playwright/test';

const FIXTURE = '/e2e/fixtures/tooltip-hover.html';
const TOOLTIP = '#hover-tip';
const TRIGGER = '#hover-trigger';
const BUBBLE = '#hover-tip [part="tooltip"]';
const DEFAULT_TOOLTIP = '#default-tip';
const DEFAULT_TRIGGER = '#default-trigger';
const DEFAULT_BUBBLE = '#default-tip [part="tooltip"]';

/** The hide delay of the fixture tooltip, kept generous so timing assertions never race CI. */
const HIDE_DELAY = 600;

/** The component's default hide delay, used by `#default-tip`. */
const DEFAULT_HIDE_DELAY = 300;

interface Point {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();

  if (!box) {
    throw new Error('missing bounding box');
  }

  return {left: box.x, top: box.y, width: box.width, height: box.height};
}

async function selection(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

test.beforeEach(async ({page}) => {
  await page.goto(FIXTURE);
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator(TOOLTIP)).not.toHaveAttribute('open', /.*/);
});

test('stays open across the gap to the bubble and lets its text be selected', async ({page}) => {
  const tooltip = page.locator(TOOLTIP);
  const bubble = page.locator(BUBBLE);

  await page.locator(TRIGGER).hover();
  await expect(tooltip).toHaveAttribute('open', '');

  const box = await boxOf(bubble);

  await page.mouse.move(box.left + 10, box.top + box.height / 2);

  // Longer than the hide delay: resting on the bubble itself keeps the tooltip open.
  await page.waitForTimeout(HIDE_DELAY + 150);
  await expect(tooltip).toHaveAttribute('open', '');

  const style = await bubble.evaluate((element) => {
    const computed = getComputedStyle(element);

    return {pointerEvents: computed.pointerEvents, userSelect: computed.userSelect};
  });

  expect(style.pointerEvents).toBe('auto');
  expect(style.userSelect).toContain('text');

  // Drag a selection across the bubble's first line and confirm the browser selected its text.
  // Anchored on the first text line: the vertical middle can fall between line boxes, where
  // Chromium refuses to start a selection.
  const dragY = box.top + 12;

  await page.mouse.move(box.left + 10, dragY);
  await page.mouse.down();
  await page.mouse.move(box.left + box.width - 14, dragY, {steps: 12});
  await page.mouse.up();

  const selected = await selection(page);

  expect(selected.length).toBeGreaterThan(0);
  expect(selected).toContain('immediately');

  // Releasing inside the bubble keeps the tooltip open, selection included.
  await expect(tooltip).toHaveAttribute('open', '');
  expect(await selection(page)).toBe(selected);
});

test('closes after the hide delay once the pointer leaves both trigger and bubble', async ({page}) => {
  const tooltip = page.locator(TOOLTIP);

  await page.locator(TRIGGER).hover();
  await expect(tooltip).toHaveAttribute('open', '');

  await page.mouse.move(8, 8);

  // Still open inside the hide delay window...
  await page.waitForTimeout(200);
  await expect(tooltip).toHaveAttribute('open', '');

  // ...and closed once it elapses.
  await expect(tooltip).not.toHaveAttribute('open', /.*/, {timeout: 3000});
});

test('Escape closes the tooltip immediately while the pointer is over the bubble', async ({page}) => {
  const tooltip = page.locator(TOOLTIP);

  await page.locator(TRIGGER).focus();
  await expect(tooltip).toHaveAttribute('open', '');

  const box = await boxOf(page.locator(BUBBLE));

  await page.mouse.move(box.left + 10, box.top + box.height / 2);
  await expect(tooltip).toHaveAttribute('open', '');

  await page.keyboard.press('Escape');
  await expect(tooltip).not.toHaveAttribute('open', /.*/);
});

test('stays open for selection when the trigger has focus: click the trigger, then drag-select', async ({page}) => {
  const tooltip = page.locator(TOOLTIP);

  // A real click focuses the trigger, and the mousedown inside the bubble that starts the
  // selection blurs it again; neither may close the tooltip.
  await page.locator(TRIGGER).click();
  await expect(tooltip).toHaveAttribute('open', '');

  const box = await boxOf(page.locator(BUBBLE));
  const dragY = box.top + 12;

  await page.mouse.move(box.left + 10, dragY);
  await page.mouse.down();
  await page.mouse.move(box.left + box.width - 14, dragY, {steps: 12});
  await page.mouse.up();

  await expect(tooltip).toHaveAttribute('open', '');

  const selected = await selection(page);

  expect(selected.length).toBeGreaterThan(0);
  expect(selected).toContain('immediately');
});

test('stays open across a slowly crossed gap with the default hide delay', async ({page}) => {
  const tooltip = page.locator(DEFAULT_TOOLTIP);
  const triggerBox = await boxOf(page.locator(DEFAULT_TRIGGER));

  await page.locator(DEFAULT_TRIGGER).hover();
  await expect(tooltip).toHaveAttribute('open', '');

  const bubbleBox = await boxOf(page.locator(DEFAULT_BUBBLE));
  const startX = triggerBox.left + triggerBox.width / 2;
  const startY = triggerBox.top + triggerBox.height - 1;
  const endY = bubbleBox.top + 4;
  const steps = Math.ceil((endY - startY) / 2);

  // ~2px per frame: slow and deliberate movement, the audience of WCAG 1.4.13.
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(startX, startY + ((endY - startY) * step) / steps);
    await page.waitForTimeout(16);
  }

  // Resting on the bubble: stays open well past the default hide delay.
  await page.waitForTimeout(DEFAULT_HIDE_DELAY + 150);
  await expect(tooltip).toHaveAttribute('open', '');
});
