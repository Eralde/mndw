import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadPlugins} from './plugin-loader.js';
import {pluginRegistry} from './plugin-registry.js';
import type {PluginBackendDescriptor, PluginListEntry} from './plugin-types.js';
import {appState} from '../state/app.svelte.js';

const emptyBackend: PluginBackendDescriptor = {
  endpoints: {},
  websockets: {},
  opkg: [],
  daemon: false,
  public: false,
};

function widget(name: string, over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    name,
    type: 'widget',
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'user',
    approval: 'approved',
    enabled: true,
    size: {w: 4, h: 3},
    backend: emptyBackend,
    ...over,
  } as PluginListEntry;
}

function page(name: string, route: string, over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    name,
    type: 'page',
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    route,
    backend: emptyBackend,
    ...over,
  } as PluginListEntry;
}

const goodModule = {createInstance: () => ({unmount: () => {}})};

function harness(entries: PluginListEntry[], modules: Record<string, unknown> = {}) {
  const importModule = vi.fn((url: string): Promise<unknown> => Promise.resolve(modules[url] ?? goodModule));
  const loadStylesheet = vi.fn((): Promise<void> => Promise.resolve());
  const fetchList = vi.fn((): Promise<PluginListEntry[]> => Promise.resolve(entries));

  return {importModule, loadStylesheet, fetchList};
}

afterEach(() => {
  pluginRegistry.clear();
  appState.pluginLoadError = null;
  vi.restoreAllMocks();
});

describe('loadPlugins', () => {
  it('imports and registers enabled plugins from the list', async () => {
    const h = harness([widget('alpha'), page('beta', '/beta')]);

    await loadPlugins(h);

    expect(
      pluginRegistry.getAll().map((p) => p.entry.name)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    expect(h.importModule).toHaveBeenCalledWith('/user-plugins/alpha/index.js');
    expect(h.importModule).toHaveBeenCalledWith('/plugins/beta/index.js');
  });

  it('loads a per-plugin stylesheet from the plugin dir', async () => {
    const h = harness([widget('alpha')]);

    await loadPlugins(h);

    expect(h.loadStylesheet).toHaveBeenCalledWith('/user-plugins/alpha/index.css', 'alpha');
  });

  it('skips disabled and pending entries', async () => {
    const h = harness([
      widget('on'),
      widget('off', {enabled: false}),
      widget('pending', {enabled: false, approval: 'pending'}),
    ]);

    await loadPlugins(h);

    expect(pluginRegistry.getAll().map((p) => p.entry.name)).toEqual(['on']);
    expect(h.importModule).toHaveBeenCalledTimes(1);
  });

  it('dedupes duplicate names and page routes', async () => {
    const h = harness([
      widget('dup'),
      widget('dup'),
      page('p1', '/same'),
      page('p2', '/same'),
    ]);

    await loadPlugins(h);

    const names = pluginRegistry.getAll().map((p) => p.entry.name)
      .sort();

    expect(names).toEqual(['dup', 'p1']);
  });

  it('skips a module missing createInstance but keeps the others', async () => {
    const h = harness([widget('good'), widget('bad')], {
      '/user-plugins/bad/index.js': {notCreateInstance: true},
    });

    await loadPlugins(h);

    expect(pluginRegistry.getAll().map((p) => p.entry.name)).toEqual(['good']);
  });

  it('sets pluginLoadError when the list fetch fails', async () => {
    const fetchList = vi.fn((): Promise<PluginListEntry[]> => Promise.reject(new Error('network down')));

    await loadPlugins({fetchList, importModule: vi.fn(), loadStylesheet: vi.fn()});

    expect(appState.pluginLoadError).toContain('Failed to load plugins');
    expect(pluginRegistry.getAll()).toHaveLength(0);
  });
});
