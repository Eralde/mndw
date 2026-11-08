import {expect, test} from '@playwright/test';

test('hero buttons stay under the base path', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto('');

  await page.getByRole('link', {name: 'Install mndw'}).click();
  await expect(page).toHaveURL(/\/mndw\/install(?:\.html)?$/);
  await expect(page.locator('.vp-doc')).toContainText(
    'opkg update && opkg install wget-ssl ca-bundle && wget -qO- https://eralde.github.io/mndw-opkg-feed/add_repo.sh | sh',
  );

  await page.goBack();
  await page.getByRole('link', {name: 'Build a plugin'}).click();
  await expect(page).toHaveURL(/\/mndw\/guides\/project-setup(?:\.html)?$/);
});

test('every home link resolves', async ({page, request, baseURL}) => {
  await page.goto('');

  const links = await page.locator('.vp-doc a[href]').evaluateAll((anchors) => {
    return anchors.map((anchor) => (anchor as HTMLAnchorElement).href);
  });
  const baseOrigin = new URL(baseURL ?? 'http://127.0.0.1:4174/mndw/').origin;

  for (const href of links) {
    const url = new URL(href);

    if (url.origin === baseOrigin) {
      expect(url.pathname).toMatch(/^\/mndw\//);

      const response = await request.get(url.href);

      expect(response.status(), `${url.pathname} should resolve`).toBe(200);
    }
  }
});
