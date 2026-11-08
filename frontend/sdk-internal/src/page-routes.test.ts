import {describe, expect, it} from 'vitest';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RESERVED_PAGE_ROUTES, isReservedPageRoute} from './page-routes.js';

const invalidManifestFixtures = fileURLToPath(
  new URL('../../../contracts/manifest/fixtures/invalid', import.meta.url),
);

describe('reserved page routes', () => {
  it('exposes the complete host-reserved route set', () => {
    expect(RESERVED_PAGE_ROUTES).toEqual(['/', '/login', '/packages', '/packages/services', '/settings']);
  });

  it.each(RESERVED_PAGE_ROUTES)('recognizes %s as reserved', (route) => {
    expect(isReservedPageRoute(route)).toBe(true);
  });

  it('has an invalid manifest fixture for every single-segment reserved route', () => {
    const singleSegmentRoutes = RESERVED_PAGE_ROUTES.filter((route) => route === '/' || !route.slice(1).includes('/'));

    for (const route of singleSegmentRoutes) {
      const name = route === '/' ? 'root' : route.slice(1);

      expect(existsSync(join(invalidManifestFixtures, `page-route-reserved-${name}.json`))).toBe(true);
    }
  });

  it.each(['/dashboard', '/packages-extra'])('recognizes %s as available', (route) => {
    expect(isReservedPageRoute(route)).toBe(false);
  });
});
