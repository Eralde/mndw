import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {type Locator, type Page, expect, test} from '@playwright/test';
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

async function forceReviewHover(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);

  await session.send('DOM.enable');
  await session.send('CSS.enable');

  const {nodes} = await session.send('DOM.getFlattenedDocument', {depth: -1, pierce: true});

  for (const node of nodes as {nodeId: number; attributes?: string[]}[]) {
    if (node.attributes?.includes('data-review-hover-target') === true) {
      await session.send('CSS.forcePseudoState', {nodeId: node.nodeId, forcedPseudoClasses: ['hover']});
    }
  }
}

async function computedStyle(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((element, cssProperty) => getComputedStyle(element).getPropertyValue(cssProperty), property);
}

async function hoverFirstBar(overlay: Locator): Promise<void> {
  await overlay.hover({position: {x: 12, y: 30}});
}

async function expectHoverChange(page: Page, hostSelector: string, part: string, property: string): Promise<void> {
  const target = page.locator(hostSelector).locator(`[part="${part}"]`);

  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);

  const before = await computedStyle(target, property);

  await target.hover();

  await expect.poll(async () => computedStyle(target, property), `${hostSelector} ${part} hover`).not.toBe(before);
}

async function expectDisabledHoverUnchanged(
  page: Page,
  hostSelector: string,
  part: string,
  property: string,
): Promise<void> {
  const target = page.locator(hostSelector).locator(`[part="${part}"]`);

  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);

  const before = await computedStyle(target, property);
  const bounds = await target.boundingBox();

  expect(bounds).not.toBeNull();
  await page.mouse.move((bounds?.x ?? 0) + (bounds?.width ?? 0) / 2, (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2);
  await page.waitForTimeout(150);

  expect(await computedStyle(target, property), `${hostSelector} disabled ${part} hover`).toBe(before);
}

async function focusWithTab(page: Page, target: Locator): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.keyboard.press('Tab');

    if (await target.evaluate((element) => element.matches(':focus') || document.activeElement === element)) {
      return;
    }
  }

  throw new Error('Could not focus checkbox with keyboard Tab');
}

async function addHoverContractFixture(page: Page): Promise<void> {
  await page.waitForFunction(() => customElements.get('mndw-button') !== undefined);
  await page.evaluate(async () => {
    const fixture = document.createElement('section');

    fixture.id = 'hover-contract-fixture';
    fixture.style.cssText = [
      'position:fixed',
      'z-index:999999',
      'inset:0',
      'display:grid',
      'grid-template-columns:repeat(3,minmax(0,1fr))',
      'align-content:start',
      'gap:20px',
      'padding:32px',
      'overflow:auto',
      'background:var(--mndw-surface)',
      'color:var(--mndw-text)',
    ].join(';');
    fixture.innerHTML = `
      <mndw-button id="hover-secondary" variant="secondary">Secondary</mndw-button>
      <mndw-button id="hover-secondary-disabled" variant="secondary" disabled>Disabled</mndw-button>
      <mndw-input id="hover-input" placeholder="Input"></mndw-input>
      <mndw-input id="hover-input-disabled" placeholder="Disabled input" disabled></mndw-input>
      <mndw-textarea id="hover-textarea" placeholder="Textarea" rows="2"></mndw-textarea>
      <mndw-textarea id="hover-textarea-disabled" placeholder="Disabled textarea" rows="2" disabled></mndw-textarea>
      <mndw-select id="hover-select" label="Select" value="lan">
        <mndw-option value="lan">LAN</mndw-option><mndw-option value="guest">Guest</mndw-option>
      </mndw-select>
      <mndw-select id="hover-select-disabled" label="Disabled select" value="lan" disabled>
        <mndw-option value="lan">LAN</mndw-option><mndw-option value="guest">Guest</mndw-option>
      </mndw-select>
      <mndw-checkbox id="hover-checkbox-unchecked">Unchecked</mndw-checkbox>
      <mndw-checkbox id="hover-checkbox-checked" checked>Checked</mndw-checkbox>
      <mndw-checkbox id="hover-checkbox-disabled" disabled>Disabled checkbox</mndw-checkbox>
      <mndw-switch id="hover-switch-off">Off</mndw-switch>
      <mndw-switch id="hover-switch-on" checked>On</mndw-switch>
      <mndw-switch id="hover-switch-disabled" disabled>Disabled switch</mndw-switch>
      <mndw-slider id="hover-slider" value="42"></mndw-slider>
      <mndw-slider id="hover-slider-disabled" value="42" disabled></mndw-slider>
      <mndw-segmented id="hover-segments" label="Range" value="selected">
        <mndw-segment id="hover-segment-unselected" value="other">Other</mndw-segment>
        <mndw-segment id="hover-segment-selected" value="selected">Selected</mndw-segment>
      </mndw-segmented>
      <mndw-segmented id="hover-segments-disabled" label="Disabled range" value="disabled">
        <mndw-segment id="hover-segment-disabled" value="disabled" disabled>Disabled</mndw-segment>
      </mndw-segmented>
    `;
    document.body.append(fixture);

    const components = Array.from(fixture.querySelectorAll('*'))
      .filter((element) =>
        element.localName.startsWith('mndw-')
      ) as (HTMLElement & {updateComplete: Promise<unknown>})[];

    await Promise.all(components.map((element) => element.updateComplete));
  });
}

async function addHoverReviewGrid(page: Page): Promise<void> {
  await page.evaluate(() => {
    const review = document.createElement('section');

    review.id = 'hover-review-grid';
    review.style.cssText = [
      'position:fixed',
      'z-index:999999',
      'top:120px',
      'left:6%',
      'right:6%',
      'display:grid',
      'grid-template-columns:repeat(4,minmax(0,1fr))',
      'align-content:center',
      'gap:20px',
      'padding:28px',
      'border:1px solid var(--mndw-border)',
      'border-radius:12px',
      'background:var(--mndw-surface)',
      'color:var(--mndw-text)',
      'box-shadow:0 12px 36px rgb(0 0 0 / 18%)',
      'font:inherit',
    ].join(';');
    review.innerHTML = `
      <strong style="grid-column:1/-1">Interactive control hover states</strong>
      <mndw-button variant="secondary">Secondary button</mndw-button>
      <mndw-field label="Network name"><mndw-input placeholder="Enter a name"></mndw-input></mndw-field>
      <mndw-field label="Notes"><mndw-textarea placeholder="Add a note"></mndw-textarea></mndw-field>
      <mndw-select label="Network">
        <mndw-option value="lan">LAN</mndw-option><mndw-option value="guest">Guest</mndw-option>
      </mndw-select>
      <mndw-checkbox checked>Remember network</mndw-checkbox>
      <mndw-switch checked>Automatic updates</mndw-switch>
      <mndw-slider value="42"></mndw-slider>
      <mndw-segmented label="Range" value="day">
        <mndw-segment value="day">Day</mndw-segment><mndw-segment value="week">Week</mndw-segment>
      </mndw-segmented>
    `;
    document.body.append(review);
  });
}

async function markHoverReviewTargets(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const review = document.querySelector('#hover-review-grid');
    const components = Array.from(review?.querySelectorAll('*') ?? [])
      .filter((element) =>
        element.localName.startsWith('mndw-')
      ) as (HTMLElement & {updateComplete: Promise<unknown>})[];

    await Promise.all(components.map((element) => element.updateComplete));

    const mark = (element: Element | null): void => {
      element?.setAttribute('data-review-hover-target', '');
    };
    const get = (selector: string): HTMLElement | null => review?.querySelector<HTMLElement>(selector) ?? null;

    mark(get('mndw-button')?.shadowRoot?.querySelector('button') ?? null);
    mark(get('mndw-input')?.shadowRoot?.querySelector('[part="field"]') ?? null);
    mark(get('mndw-textarea')?.shadowRoot?.querySelector('[part="field"]') ?? null);
    mark(get('mndw-select')?.shadowRoot?.querySelector('[part="trigger"]') ?? null);
    mark(get('mndw-checkbox'));
    mark(get('mndw-switch'));
    mark(get('mndw-slider')?.shadowRoot?.querySelector('[part="track"]') ?? null);
    mark(get('mndw-slider')?.shadowRoot?.querySelector('[part="thumb"]') ?? null);
    mark(get('mndw-segment[value="day"]'));
    mark(get('mndw-segment[value="week"]'));
  });
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

test('table sorting, visibility menu, and sort affordance stay stable at desktop width', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/table');
  await assertPreviews(page, 'ui/table');
  await selectTheme(page, 'light');

  const sortingTable = page.locator('.ui-demo__preview mndw-table[data-demo="sorting"]');
  const nameHeader = sortingTable.locator('button[data-sort-column="name"]');
  const indicator = nameHeader.locator('[part="sort-indicator"]');
  const indicatorWidths: number[] = [];

  for (const expectedSort of ['ascending', 'descending', null]) {
    await nameHeader.click();
    if (expectedSort === null) {
      await expect(nameHeader.locator('mndw-icon')).toHaveAttribute('name', 'arrow-up-down');
      await expect.poll(() =>
        nameHeader.evaluate((element) => element.closest('th')?.getAttribute('aria-sort') ?? null)
      )
        .toBeNull();
    } else {
      await expect.poll(() => nameHeader.evaluate((element) => element.closest('th')?.getAttribute('aria-sort')))
        .toBe(expectedSort);
    }

    indicatorWidths.push((await indicator.boundingBox())?.width ?? 0);
  }

  expect(indicatorWidths[0]).toBeGreaterThan(0);
  expect(new Set(indicatorWidths).size).toBe(1);
  await capture(page, 'table-sort-states-1280-light.png');

  const visibilityTable = page.locator('.ui-demo__preview mndw-table[data-demo="visibility"]');
  const menuTrigger = visibilityTable.locator('[part="column-menu-trigger"]');
  const preview = visibilityTable.locator('xpath=ancestor::div[contains(@class,"ui-demo__preview")]');
  const triggerBounds = await menuTrigger.boundingBox();
  const previewBounds = await preview.boundingBox();

  expect(triggerBounds).not.toBeNull();
  expect(previewBounds).not.toBeNull();
  expect(triggerBounds?.x).toBeGreaterThanOrEqual(previewBounds?.x ?? 0);
  expect((triggerBounds?.x ?? 0) + (triggerBounds?.width ?? 0))
    .toBeLessThanOrEqual((previewBounds?.x ?? 0) + (previewBounds?.width ?? 0));
  await menuTrigger.click();
  const menu = page.locator('mndw-column-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();

  await nameHeader.click();
  await expect(sortingTable.locator('tbody tr').first()).toContainText('Game console');
  await capture(page, 'table-1280-light.png');
});

test('heat-strip tooltips remain inside their chart host and preview at both endpoints', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/heat-strip');
  await assertPreviews(page, 'ui/heat-strip');
  await selectTheme(page, 'light');

  const chart = page.locator('.ui-demo__preview mndw-heat-strip').first();
  const slices = chart.locator('svg rect.slice');
  const preview = chart.locator('xpath=ancestor::div[contains(@class,"ui-demo__preview")]');

  for (
    const [index, screenshot] of [
      [0, 'heat-strip-hover-first-1280-light.png'],
      [Math.floor((await slices.count()) / 2), null],
      [-1, 'heat-strip-hover-last-1280-light.png'],
    ] as const
  ) {
    const slice = index === -1 ? slices.last() : slices.nth(index);

    await slice.hover();
    const plot = chart.locator('.plot');
    const tooltip = chart.locator('[part="tooltip"]');
    await expect(tooltip).toBeVisible();

    const plotBounds = await plot.boundingBox();
    const tooltipBounds = await tooltip.boundingBox();
    const previewBounds = await preview.boundingBox();
    const viewportWidth = await page.evaluate(() => window.innerWidth);

    expect(plotBounds).not.toBeNull();
    expect(tooltipBounds).not.toBeNull();
    expect(previewBounds).not.toBeNull();
    expect(tooltipBounds?.x).toBeGreaterThanOrEqual(plotBounds?.x ?? 0);
    expect((tooltipBounds?.x ?? 0) + (tooltipBounds?.width ?? 0))
      .toBeLessThanOrEqual((plotBounds?.x ?? 0) + (plotBounds?.width ?? 0));
    expect(tooltipBounds?.x).toBeGreaterThanOrEqual(previewBounds?.x ?? 0);
    expect((tooltipBounds?.x ?? 0) + (tooltipBounds?.width ?? 0))
      .toBeLessThanOrEqual((previewBounds?.x ?? 0) + (previewBounds?.width ?? 0));
    expect(tooltipBounds?.x).toBeGreaterThanOrEqual(0);
    expect((tooltipBounds?.x ?? 0) + (tooltipBounds?.width ?? 0)).toBeLessThanOrEqual(viewportWidth);

    if (screenshot !== null) {
      await capture(page, screenshot);
    }
  }
});

test('slider controls fill narrow documentation previews without overflow', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/slider');
  await assertPreviews(page, 'ui/slider');

  const sliders = page.locator('.ui-demo__preview mndw-slider');

  await expect(sliders).toHaveCount(3);
  for (const slider of await sliders.all()) {
    expect((await slider.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  }

  await selectTheme(page, 'light');
  await capture(page, 'slider-1280-light.png', true);
});

test('interactive controls change hover styles and disabled controls stay unchanged', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/');
  await addHoverContractFixture(page);
  await expect(page.locator('#hover-segment-unselected')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#hover-segment-selected')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#hover-segment-disabled')).toHaveAttribute('aria-disabled', 'true');

  for (
    const [host, part, property] of [
      ['#hover-secondary', 'button', 'background-color'],
      ['#hover-input', 'field', 'border-top-color'],
      ['#hover-textarea', 'field', 'border-top-color'],
      ['#hover-select', 'trigger', 'border-top-color'],
      ['#hover-checkbox-unchecked', 'box', 'background-color'],
      ['#hover-checkbox-checked', 'box', 'background-color'],
      ['#hover-switch-off', 'track', 'background-color'],
      ['#hover-switch-on', 'track', 'background-color'],
      ['#hover-slider', 'track', 'background-color'],
      ['#hover-slider', 'thumb', 'background-color'],
      ['#hover-segment-unselected', 'segment', 'background-color'],
      ['#hover-segment-selected', 'segment', 'background-color'],
    ]
  ) {
    await expectHoverChange(page, host, part, property);
  }

  for (
    const [host, part, property] of [
      ['#hover-secondary-disabled', 'button', 'background-color'],
      ['#hover-input-disabled', 'field', 'border-top-color'],
      ['#hover-textarea-disabled', 'field', 'border-top-color'],
      ['#hover-select-disabled', 'trigger', 'border-top-color'],
      ['#hover-checkbox-disabled', 'box', 'background-color'],
      ['#hover-switch-disabled', 'track', 'background-color'],
      ['#hover-slider-disabled', 'thumb', 'background-color'],
      ['#hover-segment-disabled', 'segment', 'background-color'],
    ]
  ) {
    await expectDisabledHoverUnchanged(page, host, part, property);
  }
});

test('checkbox keyboard focus ring stays on its box', async ({page}) => {
  await page.goto('ui/checkbox');
  await assertPreviews(page, 'ui/checkbox');

  const checkbox = page.locator('.ui-demo__preview mndw-checkbox:not([disabled])').first();

  await focusWithTab(page, checkbox);
  await expect(checkbox).toBeFocused();

  const outlineStyles = await checkbox.evaluate((element) => {
    const box = element.shadowRoot?.querySelector('[part="box"]');

    return {
      host: getComputedStyle(element).outlineStyle,
      box: box === null || box === undefined ? 'none' : getComputedStyle(box).outlineStyle,
    };
  });

  expect(outlineStyles.host).toBe('none');
  expect(outlineStyles.box).not.toBe('none');
});

test('bar chart hover highlights its column and keeps the tooltip', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/bar-chart');
  await assertPreviews(page, 'ui/bar-chart');

  const chart = page.locator('.ui-demo__preview mndw-bar-chart').first();
  const overlay = chart.locator('svg rect[fill="transparent"]');
  const band = chart.locator('[part="hover-band"]');

  await hoverFirstBar(overlay);
  await expect(chart.locator('[part="tooltip"]')).toHaveAttribute('data-visible', '');
  await expect(band).toHaveAttribute('data-active', '');
  await expect.poll(async () => computedStyle(band, 'opacity')).toBe('1');

  const bandBounds = await band.boundingBox();
  const barBounds = await chart.locator('svg rect[data-bar="true"]').evaluateAll((bars) =>
    bars.map((bar) => {
      const bounds = bar.getBoundingClientRect();

      return {left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height};
    })
  );

  expect(bandBounds).not.toBeNull();

  const overlappingBars = barBounds.filter((bar) => (
    (bandBounds?.x ?? 0) < bar.left + bar.width
    && (bandBounds?.x ?? 0) + (bandBounds?.width ?? 0) > bar.left
    && (bandBounds?.y ?? 0) < bar.top + bar.height
    && (bandBounds?.y ?? 0) + (bandBounds?.height ?? 0) > bar.top
  ));

  expect(overlappingBars).toHaveLength(1);
  expect(await chart.locator('svg rect[part="hover-band"] ~ rect[data-bar="true"]').count()).toBeGreaterThan(0);

  await chart.evaluate(async (element) => {
    const chartElement = element as HTMLElement & {requestUpdate: () => void; updateComplete: Promise<boolean>};

    chartElement.requestUpdate();
    await chartElement.updateComplete;
  });
  await expect.poll(async () => computedStyle(band, 'opacity')).toBe('1');

  await selectTheme(page, 'light');
  await hoverFirstBar(overlay);
  await capture(page, 'bar-chart-hover-1280-light.png');
  await selectTheme(page, 'dark');
  await hoverFirstBar(overlay);
  await capture(page, 'bar-chart-hover-1280-dark.png');

  await page.mouse.move(0, 0);
  await expect.poll(async () => computedStyle(band, 'opacity')).toBe('0');
});

test('captures secondary button and shared control hover states in both themes', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('ui/button');
  await assertPreviews(page, 'ui/button');
  await selectTheme(page, 'light');

  const secondaryButton = page.locator('.ui-demo__preview mndw-button[variant="secondary"]').first();

  await secondaryButton.locator('button').hover();
  await capture(page, 'button-secondary-hover-1280-light.png');
  await selectTheme(page, 'dark');
  await secondaryButton.locator('button').hover();
  await capture(page, 'button-secondary-hover-1280-dark.png');

  await addHoverReviewGrid(page);
  await markHoverReviewTargets(page);

  const reviewButton = page.locator('#hover-review-grid mndw-button').locator('[part="button"]');

  await reviewButton.hover();
  await forceReviewHover(page);
  await capture(page, 'hover-states-1280-dark.png');
  await selectTheme(page, 'light');
  await reviewButton.hover();
  await forceReviewHover(page);
  await capture(page, 'hover-states-1280-light.png');
});

test('captures checkbox focus, switch hover, and selected segment hover in both themes', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});

  await page.goto('ui/checkbox');
  await assertPreviews(page, 'ui/checkbox');

  const checkbox = page.locator('.ui-demo__preview mndw-checkbox:not([disabled])').first();

  await selectTheme(page, 'light');
  await focusWithTab(page, checkbox);
  await expect(checkbox).toBeFocused();
  await checkbox.hover();
  await capture(page, 'checkbox-focus-hover-1280-light.png');
  await selectTheme(page, 'dark');
  await focusWithTab(page, checkbox);
  await expect(checkbox).toBeFocused();
  await checkbox.hover();
  await capture(page, 'checkbox-focus-hover-1280-dark.png');

  await page.goto('ui/switch');
  await assertPreviews(page, 'ui/switch');

  const toggle = page.locator('.ui-demo__preview mndw-switch:not([disabled])').first();

  await selectTheme(page, 'light');
  await toggle.hover();
  await capture(page, 'switch-hover-1280-light.png');
  await selectTheme(page, 'dark');
  await toggle.hover();
  await capture(page, 'switch-hover-1280-dark.png');

  await page.goto('ui/segmented');
  await assertPreviews(page, 'ui/segmented');

  const selectedSegment = page.locator('.ui-demo__preview mndw-segment[aria-checked="true"]').first();

  await expect(selectedSegment).toHaveCount(1);
  await selectTheme(page, 'light');
  await selectedSegment.hover();
  await capture(page, 'segmented-1280-light.png');
  await selectTheme(page, 'dark');
  await selectedSegment.hover();
  await capture(page, 'segmented-1280-dark.png');
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
