import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {type Page, expect, test} from '@playwright/test';
import {UI_CATALOG} from '../../docs/plugin-author/.vitepress/ui-catalog.js';

const UI_PAGES = ['ui/', ...UI_CATALOG.map((entry) => `ui/${entry.slug}`)];
// Review screenshots are opt-in: set MNDW_DOCS_SCREENSHOTS to a writable directory to capture them.
const SCREENSHOT_DIR = process.env.MNDW_DOCS_SCREENSHOTS;

async function capture(page: Page, name: string, fullPage = false): Promise<void> {
  if (!SCREENSHOT_DIR) {
    return;
  }

  mkdirSync(SCREENSHOT_DIR, {recursive: true});
  await page.screenshot({path: resolve(SCREENSHOT_DIR, name), fullPage});
}

async function assertPreviews(page: Page, path: string): Promise<void> {
  await page.waitForFunction(() => {
    const previews = Array.from(document.querySelectorAll('.ui-demo__preview'));

    return previews.length > 0 && previews.every((preview) => preview.children.length > 0);
  });
  await page.waitForFunction(() => {
    const elements = Array.from(document.querySelectorAll('.ui-demo__preview *'))
      .filter((element) => element.localName.startsWith('mndw-'));

    return elements.every((element) => customElements.get(element.localName) !== undefined);
  });

  const previewElements = await page.locator('.ui-demo__preview').evaluateAll((previews) => {
    const elements = previews.flatMap((preview) => Array.from(preview.querySelectorAll('*')))
      .filter((element) => element.localName.startsWith('mndw-'));

    return elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const assignedSlotHidden = element.assignedSlot?.hidden ?? false;
      const hidden = element.hasAttribute('hidden')
        || assignedSlotHidden
        || style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse';

      return {
        tagName: element.localName,
        defined: customElements.get(element.localName) !== undefined,
        width: bounds.width,
        height: bounds.height,
        visible: !hidden && element.getClientRects().length > 0,
        inactivePanel: element.localName === 'mndw-tab-panel' && element.hasAttribute('hidden'),
      };
    });
  });

  for (const element of previewElements) {
    expect(element.defined, `${path} defines ${element.tagName}`).toBe(true);

    if (element.visible && !element.inactivePanel) {
      expect(element.width, `${path} ${element.tagName} width`).toBeGreaterThan(0);
      expect(element.height, `${path} ${element.tagName} height`).toBeGreaterThan(0);
    }
  }
}

async function selectTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const desiredLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const currentTheme = await page.locator('html').getAttribute('data-theme');

  if (currentTheme !== theme) {
    await page.getByRole('switch', {name: currentTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'})
      .first()
      .click();
  }

  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.getByRole('switch', {name: desiredLabel}).first()).toBeVisible();
}

async function selectValue(select: ReturnType<Page['locator']>): Promise<string> {
  return select.evaluate((element) => (element as HTMLElement & {value?: string}).value ?? '');
}

for (
  const {appearance, expectedTheme, title} of [
    {appearance: null, expectedTheme: 'dark', title: 'system appearance'},
    {appearance: 'light', expectedTheme: 'light', title: 'stored light appearance'},
  ]
) {
  test(`head theme follows ${title} before app modules run`, async ({page}) => {
    await page.emulateMedia({colorScheme: 'dark'});
    await page.addInitScript((storedAppearance: string | null) => {
      if (storedAppearance === null) {
        localStorage.removeItem('vitepress-theme-appearance');
      } else {
        localStorage.setItem('vitepress-theme-appearance', storedAppearance);
      }
    }, appearance);
    await page.route('**/*', (route) => {
      if (route.request().resourceType() === 'script') {
        return route.abort();
      }

      return route.continue();
    });

    await page.goto('ui/button', {waitUntil: 'domcontentloaded'});

    const theme = await page.evaluate(() => document.documentElement.dataset.theme);

    expect(theme).toBe(expectedTheme);
  });
}

for (const path of UI_PAGES) {
  for (const viewport of [{width: 1280, height: 900}, {width: 390, height: 844}]) {
    test(`${path} renders UI examples at ${viewport.width}px without errors or overflow`, async ({page}) => {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const hydrationWarnings: string[] = [];

      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }

        if (message.type() === 'warning' && message.text().includes('Hydration')) {
          hydrationWarnings.push(message.text());
        }
      });

      await page.setViewportSize(viewport);
      await page.goto(path);

      if (path === 'ui/') {
        await page.locator('.ui-catalog__card').first()
          .waitFor();
      } else {
        await assertPreviews(page, path);
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

      expect(overflow, `${path} has no horizontal overflow at ${viewport.width}px`).toBe(false);
      expect(pageErrors, `${path} has no page errors`).toEqual([]);
      expect(consoleErrors, `${path} has no console errors`).toEqual([]);
      expect(hydrationWarnings, `${path} has no hydration warnings`).toEqual([]);
    });
  }
}

test('button page renders live elements and keeps sidebar/footer titles as text', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/button');
  await page.waitForFunction(() => customElements.get('mndw-button') !== undefined);
  await assertPreviews(page, 'ui/button');

  const buttons = page.locator('.ui-demo__preview mndw-button');

  await expect(buttons).toHaveCount(7);

  for (const button of await buttons.all()) {
    const bounds = await button.boundingBox();

    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
  }

  const docsChromeTags = await page.locator('.VPSidebar, .VPDocFooter').evaluateAll((containers) => {
    return containers.flatMap((container) => Array.from(container.querySelectorAll('*')))
      .map((element) => element.localName)
      .filter((tag) => tag.startsWith('mndw-'));
  });

  expect(docsChromeTags).toEqual([]);
  await expect(page.locator('.VPSidebar a[href="/mndw/ui/button.html"]')).toHaveText('<mndw-button>');
});

test('mobile menu shows UI titles as text', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('ui/button');
  await page.getByRole('button', {name: 'Menu'}).click();

  const link = page.locator('.VPSidebar a[href="/mndw/ui/button.html"]');

  await expect(link).toBeVisible();
  await expect(link).toHaveText('<mndw-button>');

  const liveTags = await page.locator('.VPSidebar, .VPDocFooter').evaluateAll((containers) => {
    return containers.flatMap((container) => Array.from(container.querySelectorAll('*')))
      .map((element) => element.localName)
      .filter((tag) => tag.startsWith('mndw-'));
  });

  expect(liveTags).toEqual([]);
});

test('declarative demos preserve attributes after SPA navigation and full load', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/button');
  await page.locator('.VPSidebar a[href="/mndw/ui/slider.html"]').click();
  await expect(page).toHaveURL(/\/mndw\/ui\/slider(?:\.html)?$/u);

  const secondSlider = page.locator('.ui-demo__preview mndw-slider').nth(1);

  await expect(secondSlider).toHaveAttribute('aria-valuemax', '20');
  await expect(secondSlider).toHaveAttribute('aria-valuenow', '10');

  await page.goto('ui/slider');
  await expect(page.locator('.ui-demo__preview mndw-slider').nth(1)).toHaveAttribute('aria-valuemax', '20');
  await expect(page.locator('.ui-demo__preview mndw-slider').nth(1)).toHaveAttribute('aria-valuenow', '10');

  await page.locator('.VPSidebar a[href="/mndw/ui/icon.html"]').click();
  await expect(page.locator('.ui-demo__preview mndw-icon use').first()).toHaveAttribute('href', /.+/u);
});

test('CSS classes previews use kit table and toolbar styles', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/css-classes');

  const table = page.locator('.ui-demo__preview table.mndw-table').first();
  const cell = table.locator('td').first();
  const heading = page.locator('.ui-demo__preview .mndw-toolbar h3').first();

  await expect.poll(() => table.evaluate((element) => getComputedStyle(element).display)).toBe('table');
  await expect.poll(() => cell.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe('0px');
  await expect.poll(() => heading.evaluate((element) => getComputedStyle(element).marginTop)).toBe('0px');
});

test('theme toggle changes in both directions without a reload', async ({page}) => {
  await page.goto('ui/button');
  await page.waitForFunction(() => customElements.get('mndw-button') !== undefined);
  await selectTheme(page, 'light');

  const buttonColor = async (): Promise<string> => {
    return page.locator('.ui-demo__preview mndw-button[variant="secondary"]').first()
      .evaluate((button) => {
        const part = button.shadowRoot?.querySelector('[part="button"]');

        return part === null || part === undefined ? '' : getComputedStyle(part).backgroundColor;
      });
  };

  const lightColor = await buttonColor();

  await selectTheme(page, 'dark');

  const darkColor = await buttonColor();

  expect(darkColor).not.toBe(lightColor);

  await selectTheme(page, 'light');
  await expect.poll(buttonColor).toBe(lightColor);
});

test('UI catalog navigation keeps the SPA alive and renders line chart data', async ({page}) => {
  await page.goto('ui/');
  await page.evaluate(() => {
    (window as Window & {__uiSpaMark?: string}).__uiSpaMark = 'same-document';
  });

  await page.locator('.ui-catalog__card').filter({hasText: '<mndw-line-chart>'})
    .click();
  await expect(page).toHaveURL(/\/mndw\/ui\/line-chart(?:\.html)?$/u);
  await expect.poll(() =>
    page.locator('.ui-demo__preview mndw-line-chart').evaluate((chart) => {
      return chart.shadowRoot?.querySelector('svg path')?.getAttribute('d') ?? '';
    })
  ).not.toBe('');
  await expect.poll(() =>
    page.evaluate(() => {
      return (window as Window & {__uiSpaMark?: string}).__uiSpaMark;
    })
  ).toBe('same-document');
});

test('mobile select uses host sheet, restores focus, and updates value', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('ui/select');
  await assertPreviews(page, 'ui/select');

  const select = page.locator('.ui-demo__preview mndw-select').first();

  await select.click();

  const dialog = page.locator('.mndw-overlay-dialog');

  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.mndw-overlay-dialog__title')).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Close'})).toBeVisible();
  await expect.poll(() =>
    dialog.locator('mndw-select-panel').evaluate((panel) => {
      const list = panel.shadowRoot?.querySelector('.listbox');

      return list === null || list === undefined ? 0 : Number.parseFloat(getComputedStyle(list).paddingTop);
    })
  ).toBeGreaterThan(0);

  await capture(page, 'select-sheet-390-light.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(select).toBeFocused();

  await select.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('option', {name: 'Guest'}).click();
  await expect.poll(() => selectValue(select)).toBe('guest');

  await expect(dialog).toBeHidden();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await select.click();
  await expect(dialog).toBeVisible();
  await capture(page, 'select-sheet-390-dark.png');
});

test('desktop select uses anchored popover and updates value', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/select');
  await assertPreviews(page, 'ui/select');

  const select = page.locator('.ui-demo__preview mndw-select').first();

  await select.click();

  const panel = page.locator('.mndw-overlay-positioner--popover mndw-select-panel');

  await expect(panel).toBeVisible();

  const selectBounds = await select.boundingBox();
  const panelBounds = await panel.boundingBox();

  expect(selectBounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(panelBounds?.y).toBeGreaterThanOrEqual((selectBounds?.y ?? 0) + (selectBounds?.height ?? 0));
  await capture(page, 'select-popover-1280-light.png');

  await panel.getByRole('option', {name: 'Guest'}).click();
  await expect.poll(() => selectValue(select)).toBe('guest');
});

test('tooltip trigger can receive focus and shows tooltip text', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/tooltip');
  await assertPreviews(page, 'ui/tooltip');

  const tooltip = page.locator('.ui-demo__preview mndw-tooltip').nth(1);
  const trigger = tooltip
    .locator('mndw-button');

  await trigger.locator('button').focus();
  await expect(tooltip).toHaveAttribute('open', '');
  await expect(tooltip).toHaveAttribute('text', 'Refresh status');
});

test('all UI pages avoid device endpoints', async ({page}) => {
  const deviceRequests: string[] = [];

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;

    if (/^\/(?:api|rci|auth|ci)(?:\/|$)/u.test(pathname)) {
      deviceRequests.push(pathname);
    }
  });

  for (const path of UI_PAGES) {
    await page.goto(path);
  }

  expect(deviceRequests).toEqual([]);
});

test('captures requested UI playground review screenshots', async ({page}) => {
  test.skip(!SCREENSHOT_DIR, 'Set MNDW_DOCS_SCREENSHOTS to capture review screenshots.');
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/css-classes');
  await assertPreviews(page, 'ui/css-classes');
  await selectTheme(page, 'light');
  await capture(page, 'css-classes-1280-light.png', true);

  await page.goto('ui/button');

  const button = page.locator('.ui-demo__preview mndw-button').first();

  await button.waitFor();
  await button.evaluate((element) => customElements.whenDefined(element.localName));
  await capture(page, 'sidebar-ui-1280-light.png', true);
});

test('icon sprite and catalog links stay under the base path', async ({page}) => {
  const spriteResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());

    return url.pathname.startsWith('/mndw/assets/') && url.pathname.endsWith('.svg');
  });

  await page.goto('ui/icon');
  await page.waitForFunction(() => customElements.get('mndw-icon') !== undefined);

  const href = await page.locator('.ui-demo__preview mndw-icon').first()
    .evaluate((icon) => icon.shadowRoot?.querySelector('use')?.getAttribute('href') ?? '');

  expect(href).toMatch(/^\/mndw\//u);

  const spriteResponse = await spriteResponsePromise;

  expect(spriteResponse.status()).toBe(200);

  await page.goto('ui/');

  const links = await page.locator('.ui-catalog__card').evaluateAll((cards) => {
    return cards.map((card) => card.getAttribute('href') ?? '');
  });

  expect(links.length).toBe(UI_CATALOG.length);

  for (const cardHref of links) {
    expect(cardHref).toMatch(/^\/mndw\/ui\//u);
  }
});
