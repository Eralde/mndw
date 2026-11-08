import {type Page, expect, test} from '@playwright/test';

const viewports = [
  {name: 'phone', width: 390, height: 844},
  {name: 'tablet', width: 800, height: 1024},
];

const routes = [
  {start: '', link: 'Install on the router', expected: /\/mndw\/install(?:\.html)?$/},
  {start: 'install', link: 'Project setup', expected: /\/mndw\/guides\/project-setup(?:\.html)?$/},
  {start: 'guides/rci-api', link: 'Install on the router', expected: /\/mndw\/install(?:\.html)?$/},
  {start: 'api/', link: '← Documentation', expected: /\/mndw\/(?:index\.html)?$/},
];

async function isOpen(page: Page): Promise<boolean> {
  const sidebar = page.locator('.VPSidebar');
  const toggle = page.locator('.VPNav').getByRole('button', {name: 'Menu'});
  const box = await sidebar.boundingBox();

  return (await sidebar.evaluate((element) => element.classList.contains('open')))
    && (await toggle.getAttribute('aria-expanded')) === 'true'
    && box !== null
    && box.x >= 0;
}

async function isClosed(page: Page): Promise<boolean> {
  const sidebar = page.locator('.VPSidebar');
  const toggle = page.locator('.VPNav').getByRole('button', {name: 'Menu'});
  const box = await sidebar.boundingBox();

  return !(await sidebar.evaluate((element) => element.classList.contains('open')))
    && (await toggle.getAttribute('aria-expanded')) === 'false'
    && box !== null
    && box.x + box.width <= 0;
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} menu controls at ${viewport.width}px`, () => {
    test.use({viewport: {width: viewport.width, height: viewport.height}});

    test('one menu control', async ({page}) => {
      await page.goto('');

      await expect(page.locator('.VPNav').getByRole('button', {name: 'Menu'})).toHaveCount(1);

      if (viewport.width === 800) {
        await expect(page.locator('.VPNavBarExtra button:visible')).toHaveCount(0);
      }

      await expect.poll(() =>
        page.locator('.VPLocalNav .menu').evaluate((element) => {
          return getComputedStyle(element).display;
        })
      ).toBe('none');
    });

    test('toggle opens and closes the tree', async ({page}) => {
      await page.goto('');

      const toggle = page.locator('.VPNav').getByRole('button', {name: 'Menu'});
      const sidebar = page.locator('.VPSidebar');

      await expect(toggle).toHaveAttribute('aria-controls', 'VPSidebarNav');
      await expect.poll(() => isClosed(page)).toBe(true);
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => isOpen(page)).toBe(true);
      await expect(page.locator('#VPSidebarNav')).toBeFocused();
      await expect(page.locator('#VPNavScreen')).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect.poll(() => isClosed(page)).toBe(true);
      await expect(toggle).toBeFocused();
      await expect(page.locator('#VPNavScreen')).toHaveCount(0);

      await toggle.click();
      await expect.poll(() => isOpen(page)).toBe(true);

      const currentViewport = page.viewportSize();

      expect(currentViewport).not.toBeNull();
      await page.locator('.VPBackdrop').click({
        position: {['x']: (currentViewport?.width ?? 390) - 20, ['y']: 200},
      });
      await expect.poll(() => isClosed(page)).toBe(true);
      await expect(toggle).toBeFocused();
      await expect(page.locator('#VPNavScreen')).toHaveCount(0);

      await toggle.click();
      await expect.poll(() => isOpen(page)).toBe(true);

      const toggleIsOnTop = await toggle.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);

        return top === button || button.contains(top);
      });

      expect(toggleIsOnTop).toBe(true);
      await toggle.click();
      await expect.poll(() => isClosed(page)).toBe(true);
      await expect(toggle).toBeFocused();
      await expect(page.locator('#VPNavScreen')).toHaveCount(0);
      await expect(sidebar).not.toHaveClass(/\bopen\b/);
    });
  });

  test.describe(`${viewport.name} scrolled navigation at ${viewport.width}px`, () => {
    test.use({viewport: {width: viewport.width, height: viewport.height}});

    test('menu stays reachable after scrolling', async ({page}) => {
      await page.goto('tutorials/rci-device-name-widget');
      await page.evaluate(() => window.scrollTo(0, 2000));

      const scrollY = await page.evaluate(() => window.scrollY);
      const toggle = page.locator('.VPNav').getByRole('button', {name: 'Menu'});
      const toggleBox = await toggle.boundingBox();
      const navBox = await page.locator('.VPNav').boundingBox();
      const localNavBox = await page.locator('.VPLocalNav').boundingBox();
      const currentViewport = page.viewportSize();

      expect(scrollY).toBeGreaterThanOrEqual(2000);
      expect(toggleBox).not.toBeNull();
      expect(currentViewport).not.toBeNull();
      expect(toggleBox?.x).toBeGreaterThanOrEqual(0);
      expect(toggleBox?.y).toBeGreaterThanOrEqual(0);
      expect((toggleBox?.x ?? 0) + (toggleBox?.width ?? 0)).toBeLessThanOrEqual(currentViewport?.width ?? 0);
      expect((toggleBox?.y ?? 0) + (toggleBox?.height ?? 0)).toBeLessThanOrEqual(currentViewport?.height ?? 0);

      await toggle.click();
      await expect.poll(() => isOpen(page)).toBe(true);

      expect(navBox).not.toBeNull();
      expect(localNavBox).not.toBeNull();
      expect(localNavBox?.y).toBeGreaterThanOrEqual((navBox?.y ?? 0) + (navBox?.height ?? 0));
    });
  });

  test.describe(`${viewport.name} route navigation at ${viewport.width}px`, () => {
    test.use({viewport: {width: viewport.width, height: viewport.height}});

    for (const route of routes) {
      test(`navigating from ${route.start || 'home'} closes the tree`, async ({page}) => {
        await page.goto(route.start);

        const toggle = page.locator('.VPNav').getByRole('button', {name: 'Menu'});

        await toggle.click();
        await expect.poll(() => isOpen(page)).toBe(true);
        await page.locator('.VPSidebar').getByRole('link', {name: route.link})
          .click();
        await expect(page).toHaveURL(route.expected);
        await expect.poll(() => isClosed(page)).toBe(true);
      });
    }
  });

  test.describe(`${viewport.name} sidebar footer at ${viewport.width}px`, () => {
    test.use({viewport: {width: viewport.width, height: viewport.height}});

    test('theme toggle and GitHub reachable', async ({page}) => {
      await page.goto('');
      await page.locator('.VPNav').getByRole('button', {name: 'Menu'})
        .click();

      const sidebar = page.locator('.VPSidebar');
      const appearance = sidebar.locator('button[title^="Switch to"]');
      const before = await page.locator('html').evaluate((element) => element.classList.contains('dark'));

      await expect(appearance).toBeVisible();
      await expect(sidebar.getByRole('link', {name: 'GitHub'})).toHaveAttribute(
        'href',
        'https://github.com/Eralde/mndw',
      );
      await appearance.click();
      await expect.poll(() => page.locator('html').evaluate((element) => element.classList.contains('dark')))
        .toBe(!before);
    });
  });
}

for (const width of [390, 800]) {
  for (const route of ['', 'install', 'guides/project-setup']) {
    test(`no horizontal page overflow at ${width}px on ${route || 'home'}`, async ({page}) => {
      await page.setViewportSize({width, height: 844});
      await page.goto(route);

      const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

      expect(overflows).toBe(false);

      if (width === 390 && route === 'install') {
        const command = page.locator('.vp-doc pre').filter({hasText: 'wget -qO-'})
          .first();
        const dimensions = await command.evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          whiteSpace: getComputedStyle(element).whiteSpace,
        }));

        expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
        expect(dimensions.whiteSpace).not.toBe('pre-wrap');
      }
    });
  }
}

test('desktop shows the sidebar on the home page', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto('');

  const nav = page.locator('#VPSidebarNav');
  const box = await nav.boundingBox();

  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box?.x).toBeLessThan(1280);
  await expect(page.locator('.VPNav').getByRole('button', {name: 'Menu'})).toBeHidden();
});
