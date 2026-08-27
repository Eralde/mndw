import {describe, expect, it} from 'vitest';
import {packageManagerPath, packageManagerTabFromPath} from './package-manager-route.js';

describe('package manager routes', () => {
  it.each(
    [
      ['/packages', 'packages'],
      ['/packages/', 'packages'],
      ['/packages/services', 'services'],
      ['/packages/services/', 'services'],
    ] as const,
  )('maps %s to %s', (pathname, expected) => {
    expect(packageManagerTabFromPath(pathname)).toBe(expected);
  });

  it.each(['/packages/other', '/packages/services/extra', '/other'])('rejects unsupported path %s', (pathname) => {
    expect(packageManagerTabFromPath(pathname)).toBeNull();
  });

  it('builds both static paths', () => {
    expect(packageManagerPath('packages')).toBe('/packages');
    expect(packageManagerPath('services')).toBe('/packages/services');
  });
});
