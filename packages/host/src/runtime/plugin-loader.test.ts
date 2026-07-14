import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadPlugins} from './plugin-loader.js';
import {pluginRegistry} from './plugin-registry.js';
import type {PluginBackendDescriptor, PluginListEntry} from './plugin-types.js';
import {clearPluginVersionWarnings, getPluginVersionWarnings} from './plugin-version-warnings.svelte.js';
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
  const checkVersions = vi.fn((): string[] => []);

  return {importModule, loadStylesheet, fetchList, checkVersions};
}

afterEach(() => {
  clearPluginVersionWarnings();
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

describe('loadPlugins version checks', () => {
  it('runs the version check with each plugin dir and stores mismatches for Settings', async () => {
    const calls: Array<{name: string; dir: string}> = [];

    await loadPlugins({
      fetchList: () =>
        Promise.resolve([
          widget('a', {source: 'builtin'}),
          widget('b'),
        ]),
      importModule: () => Promise.resolve({createInstance: () => ({unmount() {}})}),
      loadStylesheet: () => Promise.resolve(),
      checkVersions: (entry, dir) => {
        calls.push({name: entry.name, dir});

        return entry.name === 'a' ? ['rxjs @6 (host provides @7)'] : [];
      },
    });

    expect(calls).toContainEqual({name: 'a', dir: '/plugins/a'});
    expect(calls).toContainEqual({name: 'b', dir: '/user-plugins/b'});
    await vi.waitFor(() => {
      expect(getPluginVersionWarnings('a')).toEqual(['rxjs @6 (host provides @7)']);
    });
    await vi.waitFor(() => {
      expect(getPluginVersionWarnings('b')).toEqual([]);
    });
  });

  it('a failing version check never aborts other plugins', async () => {
    await loadPlugins({
      fetchList: () =>
        Promise.resolve([
          widget('a', {source: 'builtin'}),
          widget('b', {source: 'builtin'}),
        ]),
      importModule: () => Promise.resolve({createInstance: () => ({unmount() {}})}),
      loadStylesheet: () => Promise.resolve(),
      checkVersions: (entry) => {
        if (entry.name === 'a') {
          return Promise.reject(new Error('boom'));
        }

        return Promise.resolve([]);
      },
    });

    expect(pluginRegistry.get('a')).toBeDefined();
    expect(pluginRegistry.get('b')).toBeDefined();
  });
});
