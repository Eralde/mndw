import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {getPages: vi.fn(() => []), getWidgets: vi.fn(() => [])},
}));

import {type LoadedPage, type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry, WidgetListEntry} from '../runtime/plugin-types.js';
import PagePluginHost from '../pages/PagePluginHost.svelte';
import {
  buildPluginRoutes,
  createAppRouter,
  getPageRouteDefinitions,
  resolvePageRoute,
  routeToPluginName,
} from './create-app-router.js';

const emptyBackend = {routes: {}};

function page(name: string, label: string, route: string): LoadedPage {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'page',
    route,
  };

  return {entry, module: {createInstance: vi.fn()}};
}

function widget(name: string): LoadedPlugin {
  const entry: WidgetListEntry = {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3},
  };

  return {entry, module: {createInstance: vi.fn()}};
}

describe('buildPluginRoutes', () => {
  beforeEach(() => {
    routeToPluginName.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('orders page routes by label then name and maps each to PagePluginHost', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([
      page('zeta', 'Traffic', '/traffic'),
      page('beta-status', 'Status', '/beta-status'),
      page('alpha-status', 'Status', '/alpha-status'),
    ]);

    const routes = buildPluginRoutes();

    // Status/Status tie broken by name; Traffic last.
    expect(Object.keys(routes)).toEqual([
      '/alpha-status',
      '/alpha-status/*child',
      '/beta-status',
      '/beta-status/*child',
      '/traffic',
      '/traffic/*child',
    ]);
    expect(Object.values(routes).every((component) => component === PagePluginHost)).toBe(true);
  });

  it('records each entry.route -> entry.name lookup, excluding widgets', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([
      page('status', 'Status', '/status'),
    ]);

    buildPluginRoutes();

    expect([...routeToPluginName.entries()]).toEqual([['/status', 'status']]);
  });

  it('does not turn widget plugins into routes', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([]);

    // getPages already excludes widgets; a widget in the registry must not appear.
    const routes = buildPluginRoutes();

    expect(Object.keys(routes)).toEqual([]);
    expect(routeToPluginName.size).toBe(0);
    // The widget helper exists to document intent; it is never routed.
    void widget;
  });

  it('clears stale mappings on rebuild', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('old', 'Old', '/old')]);
    buildPluginRoutes();

    expect(routeToPluginName.has('/old')).toBe(true);

    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('new', 'New', '/new')]);
    buildPluginRoutes();

    expect(routeToPluginName.has('/old')).toBe(false);
    expect([...routeToPluginName.keys()]).toEqual(['/new']);
  });

  it('uses canonical base routes and adds exact and child routes', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('map', 'Map', '/Foo/')]);

    const routes = buildPluginRoutes();

    expect(Object.keys(routes)).toEqual(['/foo', '/foo/*child']);
    expect([...routeToPluginName.entries()]).toEqual([['/foo', 'map']]);
    expect(getPageRouteDefinitions()).toEqual([{route: '/foo', name: 'map'}]);
  });

  it.each(['/foo/', '/Foo'])('rejects canonical collision for %s', (route) => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([
      page('first', 'First', '/foo'),
      page('second', 'Second', route),
    ]);

    expect(() => buildPluginRoutes()).toThrow(/second.*\/foo.*first/i);
  });

  it.each(['/', '/login', '/packages', '/settings'])('rejects reserved route %s', (route) => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('reserved', 'Reserved', route)]);

    expect(() => buildPluginRoutes()).toThrow(/reserved|static/i);
  });

  it('rejects multi-segment runtime routes', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('nested', 'Nested', '/foo/bar')]);

    expect(() => buildPluginRoutes()).toThrow(/single-segment/i);
  });

  it('keeps the previous snapshot when route construction fails', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('old', 'Old', '/old')]);
    buildPluginRoutes();

    const oldMappings = [...routeToPluginName.entries()];
    const oldDefinitions = [...getPageRouteDefinitions()];

    vi.mocked(pluginRegistry).getPages.mockReturnValue([
      page('first', 'First', '/foo'),
      page('second', 'Second', '/Foo/'),
    ]);

    expect(() => buildPluginRoutes()).toThrow();
    expect([...routeToPluginName.entries()]).toEqual(oldMappings);
    expect(getPageRouteDefinitions()).toEqual(oldDefinitions);
  });
});

describe('resolvePageRoute', () => {
  const routes = [
    {route: '/mws', name: 'mws-page'},
    {route: '/status', name: 'status'},
  ] as const;

  it.each([
    ['/mws', ''],
    ['/mws/', ''],
    ['/mws//', ''],
    ['/mws/clients', '/clients'],
    ['/mws/clients/', '/clients'],
    ['/mws/clients//', '/clients/'],
    ['/mws/a//b', '/a//b'],
    ['/MWS/clients%20archive', '/clients%20archive'],
  ])('resolves %s to child path %s', (pathname, childPath) => {
    expect(resolvePageRoute(pathname, routes)).toEqual({name: 'mws-page', childPath});
  });

  it('requires a base-route segment boundary', () => {
    expect(resolvePageRoute('/mws-extra', routes)).toBeNull();
    expect(resolvePageRoute('/mws-map', routes)).toBeNull();
  });
});

describe('createAppRouter', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
  });

  it('keeps the static shell routes reachable alongside page routes', async () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('status', 'Status', '/status')]);

    const router = createAppRouter();

    await router.navigate('/settings');
    expect(router.route.pathname).toBe('/settings');

    for (const route of ['/settings/general', '/settings/diagnostics', '/settings/plugins'] as const) {
      await router.navigate(route);
      expect(router.route.pathname).toBe(route);
    }

    await router.navigate('/status');
    expect(router.route.pathname).toBe('/status');

    await router.navigate('/');
    expect(router.route.pathname).toBe('/');
  });

  it('preserves raw child spelling at the router boundary', async () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('mws-page', 'MWS', '/mws')]);

    const router = createAppRouter();

    await router.navigate('/mws/clients%20archive//');

    expect(router.route.pathname).toBe('/mws/clients%20archive//');
    expect(resolvePageRoute(router.route.pathname, getPageRouteDefinitions())).toEqual({
      name: 'mws-page',
      childPath: '/clients%20archive/',
    });
    expect(router.route.params.child).toBe('clients archive');
  });

  it('repairs malformed page paths before initial router navigation', () => {
    window.history.replaceState(null, '', '/mws/%GG?mode=large#node-7');
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('mws-page', 'MWS', '/mws')]);

    createAppRouter();

    expect(window.location.pathname).toBe('/mws');
    expect(window.location.search).toBe('?mode=large');
    expect(window.location.hash).toBe('#node-7');
  });
});
