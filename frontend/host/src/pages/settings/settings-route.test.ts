import {describe, expect, it} from 'vitest';
import {settingsPath, settingsTabFromPath} from './settings-route.js';

describe('settings routes', () => {
  it.each([
    ['/settings/general', 'general'],
    ['/settings/diagnostics', 'diagnostics'],
    ['/settings/plugins', 'plugins'],
    ['/settings/self-update', 'self-update'],
    ['/settings/general/', 'general'],
  ])('maps %s to %s', (pathname, expected) => {
    expect(settingsTabFromPath(pathname)).toBe(expected);
  });

  it.each(['/settings', '/settings/unknown', '/settings/plugins/extra', '/other/plugins'])(
    'rejects unsupported settings path %s',
    (pathname) => {
      expect(settingsTabFromPath(pathname)).toBeNull();
    },
  );

  it.each(['general', 'diagnostics', 'plugins', 'self-update'] as const)('builds path for %s', (tab) => {
    expect(settingsPath(tab)).toBe(`/settings/${tab}`);
  });
});
