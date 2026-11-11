import {type Page, expect, test} from '@playwright/test';

const FIXTURE = '/e2e/fixtures/button-aria.html';

// `mndw-button` forwards aria state to the native button inside its shadow root. The host
// element has no role, so these reads go straight through the shadow boundary.
function controlledIds(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const inner = document.querySelector('mndw-button')?.shadowRoot?.querySelector('button');

    if (!inner || !('ariaControlsElements' in inner)) {
      return null;
    }

    const elements = inner.ariaControlsElements;

    return elements ? [...elements].map((element) => element.id) : null;
  });
}

function innerExpanded(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const inner = document.querySelector('mndw-button')?.shadowRoot?.querySelector('button');

    return inner?.getAttribute('aria-expanded') ?? null;
  });
}

test.beforeEach(async ({page}) => {
  await page.goto(FIXTURE);
  await page.waitForSelector('html[data-ready="true"]');
});

test('exposes aria-controls on the inner button through ariaControlsElements', async ({page}) => {
  await expect.poll(() => controlledIds(page)).toEqual(['mndw-sidebar']);
});

test('clears the relation when the host attribute is removed', async ({page}) => {
  await expect.poll(() => controlledIds(page)).toEqual(['mndw-sidebar']);

  await page.evaluate(() => {
    document.querySelector('mndw-button')?.removeAttribute('aria-controls');
  });

  await expect.poll(() => controlledIds(page)).toBeNull();
});

test('re-resolves the relation when the host attribute changes to another id', async ({page}) => {
  await expect.poll(() => controlledIds(page)).toEqual(['mndw-sidebar']);

  await page.evaluate(() => {
    document.querySelector('mndw-button')?.setAttribute('aria-controls', 'other-panel');
  });

  await expect.poll(() => controlledIds(page)).toEqual(['other-panel']);
});

test('forwards aria-expanded to the inner button and follows attribute changes', async ({page}) => {
  await expect.poll(() => innerExpanded(page)).toBe('false');

  await page.evaluate(() => {
    document.querySelector('mndw-button')?.setAttribute('aria-expanded', 'true');
  });

  await expect.poll(() => innerExpanded(page)).toBe('true');
});
