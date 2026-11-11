// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';

const {pristineFetch} = vi.hoisted(() => ({
  pristineFetch: vi.fn<typeof globalThis.fetch>(),
}));

vi.mock('../services/pristine-fetch.js', () => ({pristineFetch}));

import {loadPlugins} from './plugin-loader.js';
import {PluginRegistry, pluginRegistry} from './plugin-registry.js';
import type {PluginBackendDescriptor, PluginListEntry} from './plugin-types.js';
import {clearPluginVersionWarnings, getPluginVersionWarnings} from './plugin-version-warnings.svelte.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus, replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {createPluginCatalogService} from '../services/plugin-catalog.service.js';

const emptyBackend: PluginBackendDescriptor = {
  routes: {},
};

function widget(name: string, over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    name,
    type: 'widget',
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'upload',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
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
    depsStatus: 'ready',
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
  const catalogService = createPluginCatalogService({fetchCatalog: () => Promise.resolve({})});

  return {importModule, loadStylesheet, fetchList, checkVersions, catalogService};
}

afterEach(() => {
  clearPluginVersionWarnings();
  pluginRegistry.clear();
  replaceDepsStatuses([]);
  appState.pluginLoadError = null;
  vi.restoreAllMocks();
});

// eslint-disable-next-line max-lines-per-function -- loader behavior cases stay together.
describe('loadPlugins', () => {
  it('registers into the injected registry using the injected locale', async () => {
    const registry = new PluginRegistry();
    const getLocale = vi.fn(() => 'ru');
    const h = harness([widget('localized', {
      i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}},
    })]);

    await loadPlugins({...h, registry, getLocale});

    expect(registry.get('localized')).toBeDefined();
    expect(pluginRegistry.get('localized')).toBeUndefined();
    expect(getLocale).toHaveBeenCalled();
  });

  it('imports and registers enabled plugins from the list', async () => {
    const h = harness([widget('alpha'), page('beta', '/beta')]);

    await loadPlugins(h);

    expect(
      pluginRegistry.getAll().map((p) => p.entry.name)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    expect(h.importModule).toHaveBeenCalledWith('/user-plugins/alpha/index.js?v=1.0.0');
    expect(h.importModule).toHaveBeenCalledWith('/plugins/beta/index.js?v=1.0.0');
  });

  it('seeds dependency statuses from the daemon list', async () => {
    const h = harness([
      widget('installing', {depsStatus: 'installing'}),
      page('failed', '/failed', {depsStatus: 'failed'}),
    ]);

    await loadPlugins(h);

    expect(getDepsStatus('installing')).toBe('installing');
    expect(getDepsStatus('failed')).toBe('failed');
  });

  it('loads a per-plugin stylesheet from the plugin dir', async () => {
    const h = harness([widget('alpha')]);

    await loadPlugins(h);

    expect(h.loadStylesheet).toHaveBeenCalledWith('/user-plugins/alpha/index.css?v=1.0.0', 'alpha');
  });

  it('version-qualifies plugin assets so updated bundles bypass browser cache', async () => {
    const h = harness([widget('alpha', {version: '1.2.3'})]);

    await loadPlugins(h);

    expect(h.loadStylesheet).toHaveBeenCalledWith('/user-plugins/alpha/index.css?v=1.2.3', 'alpha');
    expect(h.importModule).toHaveBeenCalledWith('/user-plugins/alpha/index.js?v=1.2.3');
  });

  it('imports module before publishing a plugin with its populated catalog cell', async () => {
    const h = harness([widget('localized', {
      i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}},
    })]);
    const events: string[] = [];

    h.importModule.mockImplementation((url) => {
      events.push(`module:${url}`);

      return Promise.resolve(goodModule);
    });

    const catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      events.push(`catalog:${url}`);

      return Promise.resolve({title: 'Hello'});
    }});

    await loadPlugins({...h, catalogService});

    const loaded = pluginRegistry.get('localized');

    expect(loaded?.catalog).toBeDefined();
    expect(loaded?.catalog?.readCurrentState().primaryCatalog).toEqual({title: 'Hello'});
    expect(events[0]).toContain('module:');
    expect(events[1]).toContain('catalog:');
  });

  it('skips disabled and pending entries', async () => {
    const h = harness([
      widget('on'),
      widget('off', {enabled: false}),
      widget('pending', {enabled: false, approval: 'pending'}),
      widget('pending-live', {enabled: true, approval: 'pending'}),
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
      '/user-plugins/bad/index.js?v=1.0.0': {notCreateInstance: true},
    });

    await loadPlugins(h);

    expect(pluginRegistry.getAll().map((p) => p.entry.name)).toEqual(['good']);
  });

  it('skips a plugin whose import never settles but loads the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const h = harness([widget('good'), widget('stuck')]);
    const importModule = vi.fn((url: string): Promise<unknown> => {
      return url.startsWith('/user-plugins/stuck/') ? new Promise(() => {}) : Promise.resolve(goodModule);
    });

    await loadPlugins({...h, importModule, loadTimeoutMs: 20});

    expect(pluginRegistry.getAll().map((p) => p.entry.name)).toEqual(['good']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"stuck" did not load within 20 ms'));
  });

  it('skips a plugin whose stylesheet never settles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const h = harness([widget('good'), widget('stuck')]);
    const loadStylesheet = vi.fn((_href: string, name: string): Promise<void> => {
      return name === 'stuck' ? new Promise(() => {}) : Promise.resolve();
    });

    await loadPlugins({...h, loadStylesheet, loadTimeoutMs: 20});

    expect(pluginRegistry.getAll().map((p) => p.entry.name)).toEqual(['good']);
  });

  it('does not register a plugin that finishes loading after its timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    let finishImport: (module: unknown) => void = () => {};
    const h = harness([widget('late')]);
    const importModule = vi.fn((): Promise<unknown> =>
      new Promise((resolve) => {
        finishImport = resolve;
      })
    );

    await loadPlugins({...h, importModule, loadTimeoutMs: 20});
    finishImport(goodModule);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pluginRegistry.get('late')).toBeUndefined();
    expect(h.checkVersions).not.toHaveBeenCalled();
  });

  it('sets pluginLoadError when the list fetch fails', async () => {
    const fetchList = vi.fn((): Promise<PluginListEntry[]> => Promise.reject(new Error('network down')));

    await loadPlugins({fetchList, importModule: vi.fn(), loadStylesheet: vi.fn()});

    expect(appState.pluginLoadError).toBe('list');
    expect(pluginRegistry.getAll()).toHaveLength(0);
  });

  it('fails the list load after 15 seconds when fetchList never settles', async () => {
    vi.useFakeTimers();
    const fetchList = vi.fn((): Promise<PluginListEntry[]> => new Promise(() => {}));

    try {
      const pending = loadPlugins({fetchList, importModule: vi.fn(), loadStylesheet: vi.fn()});

      await vi.advanceTimersByTimeAsync(14_999);
      expect(appState.pluginLoadError).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      expect(appState.pluginLoadError).toBe('list');
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late result from an older load run', async () => {
    const registry = new PluginRegistry();
    let finishFirst: (entries: PluginListEntry[]) => void = () => {};
    const first = loadPlugins({
      fetchList: () => new Promise((resolve) => {
        finishFirst = resolve;
      }),
      registry,
      importModule: vi.fn(() => Promise.resolve(goodModule)),
      loadStylesheet: vi.fn(() => Promise.resolve()),
      checkVersions: () => [],
    });

    await loadPlugins({
      fetchList: () => Promise.resolve([widget('current')]),
      registry,
      importModule: vi.fn(() => Promise.resolve(goodModule)),
      loadStylesheet: vi.fn(() => Promise.resolve()),
      checkVersions: () => [],
    });
    finishFirst([widget('stale', {depsStatus: 'failed'})]);
    await first;

    expect(registry.get('current')).toBeDefined();
    expect(registry.get('stale')).toBeUndefined();
    expect(getDepsStatus('current')).toBe('ready');
    expect(getDepsStatus('stale')).toBe('ready');
    expect(appState.pluginLoadError).toBeNull();
  });

  it('fails closed when the default list fetch receives a malformed payload', async () => {
    pristineFetch.mockResolvedValue(new Response(JSON.stringify({plugins: [{}]}), {status: 200}));

    await loadPlugins({importModule: vi.fn(), loadStylesheet: vi.fn()});

    expect(pristineFetch).toHaveBeenCalledWith(
      '/api/mgmt/list',
      {signal: expect.any(AbortSignal)},
    );
    expect(appState.pluginLoadError).toBe('list');
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
