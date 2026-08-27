import {describe, expect, it} from 'vitest';
import {RESERVED_PAGE_ROUTES, isReservedPageRoute} from './page-routes.js';

describe('reserved page routes', () => {
  it('exposes the complete host-reserved route set', () => {
    expect(RESERVED_PAGE_ROUTES).toEqual(['/', '/login', '/packages', '/packages/services', '/settings']);
  });

  it.each(RESERVED_PAGE_ROUTES)('recognizes %s as reserved', (route) => {
    expect(isReservedPageRoute(route)).toBe(true);
  });

  it.each(['/dashboard', '/packages-extra'])('recognizes %s as available', (route) => {
    expect(isReservedPageRoute(route)).toBe(false);
  });
});
