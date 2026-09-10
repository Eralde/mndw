import {type Locator, type Page, expect, test} from '@playwright/test';

const FIXTURE = '/e2e/fixtures/icons.html';

async function useBoxWidth(use: Locator): Promise<number> {
  return use.evaluate((node) => (node as SVGGraphicsElement).getBBox().width);
}

async function openFixture(page: Page): Promise<void> {
  await page.goto(FIXTURE);
  await page.waitForSelector('html[data-ready="true"]');
}

test.beforeEach(async ({page}) => {
  await openFixture(page);
});

test('external use renders real geometry', async ({page}) => {
  const use = page.locator('#settings').locator('use');

  await expect.poll(async () => useBoxWidth(use)).toBeGreaterThan(0);
});

test('labeled icons expose an accessible name and decorative ones do not', async ({page}) => {
  await expect(page.getByRole('img', {name: 'Information'})).toBeVisible();
  await expect(page.locator('#settings').locator('svg')).toHaveAttribute('aria-hidden', 'true');
});

test('every instance references one shared sprite asset', async ({page}) => {
  const requested: string[] = [];

  page.on('request', (request) => {
    if (request.url().endsWith('.svg')) {
      requested.push(request.url());
    }
  });

  await openFixture(page);
  await expect.poll(async () => useBoxWidth(page.locator('#settings').locator('use'))).toBeGreaterThan(0);

  const hrefs = await page.locator('mndw-icon use').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('href') ?? '')
  );

  expect(hrefs.length).toBeGreaterThan(30);

  const bases = new Set(hrefs.map((href) => href.split('#')[0]));

  expect(bases.size).toBe(1);
  expect([...bases][0]).toContain('sprite');

  const spriteRequests = new Set(requested.filter((url) => url.includes('sprite')));

  expect(spriteRequests.size).toBeLessThanOrEqual(1);
});

test('name changes reuse the same sprite asset', async ({page}) => {
  const requested: string[] = [];

  page.on('request', (request) => {
    if (request.url().endsWith('.svg')) {
      requested.push(request.url());
    }
  });

  await openFixture(page);
  await page.locator('#shared-a').evaluate((element) => element.setAttribute('name', 'trash'));
  await expect(page.locator('#shared-a')).toHaveAttribute('name', 'trash');
  await expect.poll(async () => useBoxWidth(page.locator('#shared-a').locator('use'))).toBeGreaterThan(0);

  expect(new Set(requested.filter((url) => url.includes('sprite'))).size).toBeLessThanOrEqual(1);
});

test('size comes from the CSS box or font size', async ({page}) => {
  const small = await page.locator('#size-16').boundingBox();
  const large = await page.locator('#size-32').boundingBox();

  expect(small?.width).toBe(16);
  expect(large?.width).toBe(32);
});

test('icons inherit their container color', async ({page}) => {
  const icon = page.locator('#color-accent');
  const [iconColor, parentColor] = await icon.evaluate((element) => {
    return [getComputedStyle(element).color, getComputedStyle(element.parentElement as Element).color];
  });

  expect(iconColor).toBe(parentColor);
  expect(iconColor).not.toBe('rgb(0, 0, 0)');
  await expect.poll(async () => useBoxWidth(icon.locator('use'))).toBeGreaterThan(0);
});

test('unknown and missing names render no symbol reference', async ({page}) => {
  await expect(page.locator('#unknown').locator('use')).toHaveCount(0);
  await expect(page.locator('#missing').locator('use')).toHaveCount(0);

  const box = await page.locator('#missing').boundingBox();

  expect(box?.width).toBeGreaterThan(0);
});

test('icon-only button keeps its own accessible name', async ({page}) => {
  await expect(page.getByRole('button', {name: 'Settings'})).toBeVisible();
});

test('password toggle swaps glyphs from the shared sprite', async ({page}) => {
  const input = page.locator('#password-input');
  const toggle = input.locator('[part="password-toggle"]');

  await expect(toggle.locator('mndw-icon')).toHaveAttribute('name', 'eye');
  await expect.poll(async () => useBoxWidth(toggle.locator('mndw-icon').locator('use'))).toBeGreaterThan(0);

  await toggle.click();
  await expect(toggle.locator('mndw-icon')).toHaveAttribute('name', 'eye-off');
  await expect(toggle).toHaveAttribute('aria-label', 'Hide password');

  await toggle.click();
  await expect(toggle.locator('mndw-icon')).toHaveAttribute('name', 'eye');
  await expect(toggle).toHaveAttribute('aria-label', 'Show password');
});

test('gallery renders every catalog icon in both themes', async ({page}) => {
  await expect(page.locator('.gallery-cell mndw-icon')).toHaveCount(56);
  await expect.poll(async () => useBoxWidth(page.locator('.gallery-dark mndw-icon').first()
.locator('use')))
    .toBeGreaterThan(0);

  await page.screenshot({path: test.info().outputPath('icon-gallery.png'), fullPage: true});
});

test('sprite failure leaves the page functional', async ({page}) => {
  const errors: string[] = [];

  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/*.svg', (route) => route.abort());
  await openFixture(page);

  await expect(page.getByRole('button', {name: 'Settings'})).toBeVisible();
  await expect(page.locator('#password-input').locator('input')).toHaveAttribute('type', 'password');
  expect(errors).toEqual([]);
});
