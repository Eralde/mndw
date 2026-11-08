import {describe, expect, it, vi} from 'vitest';
import type {PluginPageTable} from '../router/host-routes.js';
import {type PluginNavigationRouter, createPluginNavigation} from './plugin-navigation.js';

function pageTable(routes: Record<string, string>): PluginPageTable {
  return {
    baseRouteOf: (pluginName): string | undefined => routes[pluginName],
    pluginNameOf: (baseRoute): string | undefined =>
      Object.entries(routes).find(([, route]) => route === baseRoute)?.[0],
  };
}

function navigationRouter(
  routes: Record<string, string>,
  navigate: (pathname: string) => unknown,
): PluginNavigationRouter {
  return {pageTable: pageTable(routes), navigate};
}

describe('createPluginNavigation', () => {
  it('builds links for host pages and plugin pages that are routable', () => {
    const navigation = createPluginNavigation({
      getRouter: () => navigationRouter({'mws-page': '/mws', 'self-page': '/self'}, vi.fn(() => Promise.resolve())),
      isDisposed: () => false,
    });

    expect(navigation.href({kind: 'settings', tab: 'general'})).toBe('/settings/general');
    expect(navigation.href({kind: 'settings'})).toBe('/settings');
    expect(navigation.href({kind: 'plugin-page', plugin: 'mws-page'})).toBe('/mws');
    expect(navigation.href({kind: 'plugin-page', plugin: 'self-page', path: 'nodes/abc'})).toBe('/self/nodes/abc');
    expect(navigation.href({kind: 'plugin-page', plugin: 'mws-page', path: 'nodes/abc'})).toBe('/mws/nodes/abc');
  });

  it('returns undefined for unknown pages, tabs, and invalid child paths', () => {
    const navigation = createPluginNavigation({
      getRouter: () => navigationRouter({'mws-page': '/mws'}, vi.fn(() => Promise.resolve())),
      isDisposed: () => false,
    });

    expect(navigation.href({kind: 'plugin-page', plugin: 'not-installed'})).toBeUndefined();
    expect(navigation.href({kind: 'plugin-page', plugin: 'not-routable'})).toBeUndefined();
    expect(navigation.href({kind: 'settings', tab: 'unknown' as never})).toBeUndefined();

    for (const path of ['nodes/../admin', 'https://example.com', '//example.com', '/absolute', 'nodes\\abc']) {
      expect(navigation.href({kind: 'plugin-page', plugin: 'mws-page', path})).toBeUndefined();
    }
  });

  it('rejects malformed JavaScript targets without throwing', () => {
    const navigate = vi.fn((_pathname: string): Promise<void> => Promise.resolve());
    const navigation = createPluginNavigation({
      getRouter: () => navigationRouter({'mws-page': '/mws'}, navigate),
      isDisposed: () => false,
    });
    const invalidTargets = [
      undefined,
      null,
      {kind: 'plugin-page', plugin: 1},
      {kind: 'plugin-page', plugin: 'mws-page', path: 5},
      {kind: 'settings', tab: 'nope'},
    ];

    for (const target of invalidTargets) {
      expect(navigation.href(target as never)).toBeUndefined();
      expect(navigation.navigate(target as never)).toBe(false);
    }

    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to a resolved target and ignores unknown targets', () => {
    const navigate = vi.fn((_pathname: string): Promise<void> => Promise.resolve());
    const navigation = createPluginNavigation({
      getRouter: () => navigationRouter({'mws-page': '/mws'}, navigate),
      isDisposed: () => false,
    });

    expect(navigation.navigate({kind: 'plugin-page', plugin: 'mws-page', path: 'nodes/abc'})).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/mws/nodes/abc');
    expect(navigation.navigate({kind: 'plugin-page', plugin: 'unknown'})).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('stops navigating after its context is disposed', () => {
    let disposed = false;
    const navigate = vi.fn((_pathname: string): Promise<void> => Promise.resolve());
    const navigation = createPluginNavigation({
      getRouter: () => navigationRouter({}, navigate),
      isDisposed: () => disposed,
    });

    disposed = true;

    expect(navigation.navigate({kind: 'dashboard'})).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
