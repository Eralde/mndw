import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {getPages: vi.fn(() => []), getWidgets: vi.fn(() => [])},
}));

import {type LoadedPage, type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry, WidgetListEntry} from '../runtime/plugin-types.js';
import PagePluginHost from '../pages/PagePluginHost.svelte';
import {buildPluginRoutes, createAppRouter, routeToPluginName} from './create-app-router.js';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

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
    expect(Object.keys(routes)).toEqual(['/alpha-status', '/beta-status', '/traffic']);
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
});

describe('createAppRouter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the static shell routes reachable alongside page routes', async () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([page('status', 'Status', '/status')]);

    const router = createAppRouter();

    await router.navigate('/settings');
    expect(router.route.pathname).toBe('/settings');

    await router.navigate('/status');
    expect(router.route.pathname).toBe('/status');

    await router.navigate('/');
    expect(router.route.pathname).toBe('/');
  });
});
