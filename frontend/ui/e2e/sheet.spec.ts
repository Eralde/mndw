import {expect, test} from '@playwright/test';

const cases = [
  {theme: 'dark', content: 'short', optionCount: 2},
  {theme: 'dark', content: 'overflowing', optionCount: 80},
  {theme: 'light', content: 'short', optionCount: 2},
  {theme: 'light', content: 'overflowing', optionCount: 80},
] as const;

for (const currentCase of cases) {
  test(`${currentCase.theme} ${currentCase.content} fallback sheet`, async ({page}) => {
    await page.setViewportSize({width: 600, height: 500});
    await page.goto(`/e2e/fixtures/sheet.html?count=${currentCase.optionCount}`);
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await page.locator('html').evaluate((element, theme) => {
      element.setAttribute('data-theme', theme);
    }, currentCase.theme);
    await page.locator('mndw-select').locator('[part="trigger"]')
      .click();

    const metrics = await page.evaluate((optionCount) => {
      const surface = document.querySelector<HTMLElement>('.mndw-ui-sheet');
      const header = document.querySelector<HTMLElement>('.mndw-ui-sheet__header');
      const body = document.querySelector<HTMLElement>('.mndw-ui-sheet__body');
      const panel = document.querySelector('mndw-select-panel');
      const scrollArea = panel?.shadowRoot?.querySelector('mndw-scroll-area');
      const viewport = scrollArea?.shadowRoot?.querySelector<HTMLElement>('[part="viewport"]');

      if (!surface || !header || !body || !viewport) {
        throw new Error('sheet geometry missing');
      }

      const surfaceBox = surface.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();

      return {
        optionCount,
        surfaceHeight: surfaceBox.height,
        surfaceBottom: surfaceBox.bottom,
        viewportHeight: window.innerHeight,
        headerBottom: headerBox.bottom,
        headerScrollHeight: header.scrollHeight,
        headerClientHeight: header.clientHeight,
        bodyOverflow: getComputedStyle(body).overflow,
        viewportOverflow: getComputedStyle(viewport).overflowY,
        viewportScrollHeight: viewport.scrollHeight,
        viewportClientHeight: viewport.clientHeight,
        pageScrollHeight: document.documentElement.scrollHeight,
        pageClientHeight: document.documentElement.clientHeight,
      };
    }, currentCase.optionCount);

    expect(metrics.headerBottom).toBeLessThanOrEqual(metrics.surfaceBottom + 1);
    expect(metrics.headerScrollHeight).toBeLessThanOrEqual(metrics.headerClientHeight + 1);
    expect(metrics.bodyOverflow).toBe('hidden');
    expect(metrics.viewportOverflow).toBe('auto');
    expect(metrics.pageScrollHeight).toBeLessThanOrEqual(metrics.pageClientHeight);
    expect(Math.abs(metrics.surfaceBottom - metrics.viewportHeight)).toBeLessThanOrEqual(1);

    if (currentCase.optionCount === 2) {
      expect(metrics.surfaceHeight).toBeLessThan(metrics.viewportHeight);
      expect(metrics.viewportScrollHeight).toBeLessThanOrEqual(metrics.viewportClientHeight + 1);
    } else {
      expect(metrics.surfaceHeight).toBeGreaterThanOrEqual(metrics.viewportHeight - 1);
      expect(metrics.viewportScrollHeight).toBeGreaterThan(metrics.viewportClientHeight);
    }
  });
}
