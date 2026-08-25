import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.goto('/e2e/fixtures/geometry.html');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
});

test('keeps DOM rows bounded and contributes positive native spacers', async ({page}) => {
  const table = page.locator('#geometry-table');
  const rows = table.locator('[part="row"]');
  const spacers = table.locator('[part="virtual-spacer"]');

  await expect.poll(async () => rows.count()).toBeLessThan(1000);
  await expect.poll(async () => spacers.count()).toBeLessThanOrEqual(2);

  const heights = await spacers.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));

  expect(heights.every((height) => height > 0)).toBe(true);
});

test('scrolls instantly to deep rows while preserving logical accessibility totals', async ({page}) => {
  const table = page.locator('#geometry-table');
  const viewport = table.locator('[part="viewport"]');

  await expect(table.locator('[part="table"]')).toHaveAttribute('aria-rowcount', '1001');
  await table.evaluate((element) => {
    const tableElement = element as HTMLElement & {scrollToRow: (key: string, options: {align: 'start'}) => boolean};

    if (!tableElement.scrollToRow('row-800', {align: 'start'})) {
      throw new Error('scrollToRow rejected a logical row');
    }
  });
  await expect.poll(async () => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  await expect(viewport.locator('[part="row"]').first()).toBeAttached();
});

test('reserves scrollbar width and keeps sticky header visible during vertical scroll', async ({page}) => {
  const table = page.locator('#geometry-table');
  const viewport = table.locator('[part="viewport"]');
  const header = table.locator('[part="header-row"]');
  const width = await viewport.evaluate((element) => element.clientWidth);
  const gutter = await viewport.evaluate((element) => getComputedStyle(element).scrollbarGutter);

  expect(gutter).toContain('stable');
  await viewport.evaluate((element) => {
    element.scrollTop = 500;
  });
  await expect.poll(async () => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await viewport.evaluate((element) => element.clientWidth)).toBe(width);
  await expect(header).toBeVisible();
});

test('keeps table controls outside the bounded horizontal scroll owner', async ({page}) => {
  const table = page.locator('#geometry-table');
  const controls = page.locator('#geometry-controls');
  const viewport = table.locator('[part="viewport"]');

  await expect(controls).toBeVisible();
  await expect(viewport).toBeAttached();
  expect(await controls.evaluate((element) => element.contains(document.querySelector('#geometry-table')))).toBe(false);

  const geometry = await page.evaluate(() => {
    const cardElement = document.querySelector<HTMLElement>('#geometry-table-card');
    const tableElement = document.querySelector<HTMLElement>('#geometry-table');
    const viewportElement = tableElement?.shadowRoot?.querySelector<HTMLElement>('[part="viewport"]');

    if (!cardElement || !tableElement || !viewportElement) {
      throw new Error('table geometry fixture missing');
    }

    return {
      cardClientWidth: cardElement.clientWidth,
      cardScrollWidth: cardElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      tableClientWidth: tableElement.clientWidth,
      viewportClientWidth: viewportElement.clientWidth,
      viewportScrollWidth: viewportElement.scrollWidth,
      viewportOverflowX: getComputedStyle(viewportElement).overflowX,
    };
  });

  expect(geometry.viewportScrollWidth).toBeGreaterThan(geometry.viewportClientWidth);
  expect(geometry.viewportOverflowX).toBe('auto');
  expect(geometry.cardScrollWidth).toBeLessThanOrEqual(geometry.cardClientWidth);
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
  expect(geometry.tableClientWidth).toBe(geometry.viewportClientWidth);
});

test('keeps shared scroll-area scrolling bounded and exposes a visible themed thumb', async ({page}) => {
  const area = page.locator('#geometry-scroll-area');
  const viewport = area.locator('[part="viewport"]');
  const thumb = area.locator('[part="thumb"]');

  await expect(viewport).toBeAttached();
  await expect.poll(async () => viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await viewport.evaluate((element) => element.clientHeight),
  );
  await expect.poll(async () => area.locator('[part="scrollbar"]').evaluate((element) => getComputedStyle(element).display))
    .toBe('block');

  await viewport.evaluate((element) => {
    element.scrollTop = 100;
  });
  await expect.poll(async () => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const thumbColor = await thumb.evaluate((element) => getComputedStyle(element).backgroundColor);

  expect(thumbColor).not.toBe('rgba(0, 0, 0, 0)');
});

test('keeps switch field label and control on one line with a positive gap', async ({page}) => {
  const geometry = await page.evaluate(() => {
    const label = document.querySelector<HTMLElement>('#geometry-field .mndw-field__label');
    const control = document.querySelector<HTMLElement>('#geometry-switch');

    if (!label || !control) {
      throw new Error('field geometry fixture missing');
    }

    const labelRect = label.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();

    return {
      horizontalGap: controlRect.left - labelRect.right,
      verticalOverlap: controlRect.top - labelRect.bottom,
    };
  });

  expect(geometry.horizontalGap).toBeGreaterThan(0);
  expect(geometry.verticalOverlap).toBeLessThan(0);
});

test('evacuates focus before scroll-out removes focused custom content', async ({page}) => {
  const table = page.locator('#geometry-table');

  const focusedKey = await table.evaluate((element) => {
    const first = element.shadowRoot?.querySelector<HTMLElement>('[part="row"]');

    if (first === null || first === undefined) {
      throw new Error('first row is not mounted');
    }

    first.tabIndex = 0;
    first.focus();

    return first.getAttribute('data-row-key');
  });

  if (focusedKey === null) {
    throw new Error('focused row has no key');
  }

  await table.evaluate((element) => {
    const tableElement = element as HTMLElement & {scrollToRow: (key: string, options: {align: 'start'}) => boolean};

    tableElement.scrollToRow('row-800', {align: 'start'});
  });
  await expect.poll(async () =>
    table.evaluate((element) => {
      const viewport = element.shadowRoot?.querySelector<HTMLElement>('[part="viewport"]');

      return viewport !== null && element.shadowRoot?.activeElement === viewport;
    })
  ).toBe(true);
});
