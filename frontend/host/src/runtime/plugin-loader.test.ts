// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';

const {pristineFetch} = vi.hoisted(() => ({
  pristineFetch: vi.fn<typeof globalThis.fetch>(),
}));

vi.mock('../services/pristine-fetch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/pristine-fetch.js')>(),
  pristineFetch,
}));

import {loadPlugins, retryPluginLoad, syncPlugins} from './plugin-loader.js';
import {PluginRegistry, pluginRegistry} from './plugin-registry.js';
import type {PluginBackendDescriptor, PluginListEntry} from './plugin-types.js';
import {clearPluginVersionWarnings, getPluginVersionWarnings} from './plugin-version-warnings.svelte.js';
import {
  getPluginListRevision,
  getPluginLoadListOutcome,
  getPluginLoadState,
  replacePluginLoadStates,
  setPluginLoadListOutcome,
} from './plugin-load-state.svelte.js';
import {appState, beginAuthRun, resetToLogin} from '../state/app.svelte.js';
import {getDepsStatus, replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {createPluginCatalogService, getPluginManifestPresentation} from '../services/plugin-catalog.service.js';
import {toast} from '../services/toast/toast.svelte.js';
import {buildPluginRoutes} from '../router/create-app-router.js';
import {getPagePluginCandidates} from './page-plugin-candidates.js';

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
  toast.clear();
  clearPluginVersionWarnings();
  pluginRegistry.clear();
  replacePluginLoadStates([]);
  setPluginLoadListOutcome('pending');
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

  it('records loaded, failed, timed out, and non-runnable plugin states', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const entries = [
      widget('loaded'),
      widget('failed'),
      widget('timeout'),
      widget('disabled', {enabled: false}),
    ];
    const importModule = vi.fn((url: string): Promise<unknown> => {
      if (url.includes('/failed/')) {
        return Promise.reject(new Error('broken import'));
      }

      if (url.includes('/timeout/')) {
        return new Promise(() => {});
      }

      return Promise.resolve(goodModule);
    });

    try {
      const pending = loadPlugins({
        fetchList: () => Promise.resolve(entries),
        importModule,
        loadStylesheet: () => Promise.resolve(),
        checkVersions: () => [],
        loadTimeoutMs: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      await pending;

      expect(getPluginLoadListOutcome()).toBe('ok');
      expect(getPluginLoadState('loaded')).toMatchObject({runnable: true, status: 'loaded', type: 'widget'});
      expect(getPluginLoadState('failed')).toMatchObject({
        runnable: true,
        status: 'failed',
        failureKind: 'error',
        type: 'widget',
      });
      expect(getPluginLoadState('timeout')).toMatchObject({
        runnable: true,
        status: 'failed',
        failureKind: 'timeout',
        type: 'widget',
      });
      expect(getPluginLoadState('disabled')).toMatchObject({runnable: false, status: 'not-runnable', type: 'widget'});
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed plugin and registers it when the retry succeeds', async () => {
    const h = harness([widget('retry')]);
    let attempts = 0;

    h.importModule.mockImplementation(() => {
      attempts += 1;

      return attempts === 1
        ? Promise.reject(new Error('first import failed'))
        : Promise.resolve(goodModule);
    });

    await loadPlugins(h);
    expect(getPluginLoadState('retry')).toMatchObject({runnable: true, status: 'failed'});

    const retry = retryPluginLoad('retry');

    expect(getPluginLoadState('retry')).toMatchObject({runnable: true, status: 'loading'});
    expect(getPluginLoadState('retry')?.failureKind).toBeUndefined();
    await expect(retry).resolves.toBe(true);

    expect(pluginRegistry.get('retry')).toBeDefined();
    expect(getPluginLoadState('retry')).toMatchObject({runnable: true, status: 'loaded'});
    expect(getPluginLoadState('retry')?.failureKind).toBeUndefined();
  });

  it('keeps a plugin failed when its retry fails', async () => {
    const h = harness([widget('retry')]);

    h.importModule.mockRejectedValue(new Error('broken import'));

    await loadPlugins(h);

    await expect(retryPluginLoad('retry')).resolves.toBe(false);

    expect(getPluginLoadState('retry')).toMatchObject({runnable: true, status: 'failed'});
  });

  it('does not let a retry from an older generation overwrite current status', async () => {
    const h = harness([widget('retry')]);

    h.importModule.mockRejectedValueOnce(new Error('first import failed'));

    await loadPlugins(h);

    let finishRetry: (module: unknown) => void = () => {};

    h.importModule.mockImplementationOnce(() =>
      new Promise((resolve) => {
        finishRetry = resolve;
      })
    );

    const retry = retryPluginLoad('retry');

    await loadPlugins({
      fetchList: () => Promise.resolve([widget('retry')]),
      importModule: () => Promise.resolve(goodModule),
      loadStylesheet: () => Promise.resolve(),
      checkVersions: () => [],
    });
    finishRetry(goodModule);
    await retry;

    expect(getPluginLoadState('retry')).toMatchObject({runnable: true, status: 'loaded'});
    expect(pluginRegistry.get('retry')).toBeDefined();
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

  it('loads enabled catalogs before importing plugins and reuses them after registration', async () => {
    const h = harness([widget('localized', {
      label: 'Manifest label',
      description: 'Manifest description',
      i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}},
    })]);
    const events: string[] = [];

    h.importModule.mockImplementation((url) => {
      events.push(`module:${url}`);

      return Promise.resolve(goodModule);
    });

    const catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      events.push(`catalog:${url}`);

      return Promise.resolve({
        'manifest.label': url.includes('ru.json') ? 'Имя' : 'Name',
        'manifest.description': url.includes('ru.json') ? 'Описание' : 'Description',
      });
    }});

    await loadPlugins({...h, catalogService, getLocale: () => 'en'});

    const loaded = pluginRegistry.get('localized');

    expect(loaded?.catalog).toBeDefined();
    expect(loaded?.catalog?.readCurrentState().primaryCatalog).toMatchObject({'manifest.label': 'Name'});
    expect(events[0]).toContain('catalog:');
    expect(events[1]).toContain('module:');
    expect(events.filter((event) => event.startsWith('catalog:'))).toHaveLength(1);
    const loadState = getPluginLoadState('localized');

    expect(loadState).toMatchObject({label: 'Manifest label', description: 'Manifest description'});
    if (loadState === undefined) {
      throw new Error('localized plugin load state should exist');
    }

    expect(getPluginManifestPresentation(loadState, loadState.catalog, 'en')).toEqual({
      label: 'Name',
      description: 'Description',
    });

    const localeGeneration = catalogService.preparePluginCatalogGeneration('ru');

    await localeGeneration.promise;
    catalogService.commitPluginCatalogGeneration(localeGeneration, () => {});

    expect(getPluginManifestPresentation(loadState, loadState.catalog, 'ru')).toEqual({
      label: 'Имя',
      description: 'Описание',
    });
    expect(events.filter((event) => event.startsWith('catalog:'))).toHaveLength(2);
  });

  it('loads catalogs for enabled plugins only, including modules that fail to import', async () => {
    const entries = [
      widget('on', {i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json'}}}),
      widget('off', {enabled: false, i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json'}}}),
      widget('pending', {approval: 'pending', enabled: false,
        i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json'}}}),
      widget('broken', {i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json'}}}),
    ];
    const catalogRequests: string[] = [];
    const catalogService = createPluginCatalogService({fetchCatalog: (url) => {
      catalogRequests.push(url);

      return Promise.resolve({'manifest.label': 'Translated'});
    }});
    const h = harness(entries);

    h.importModule.mockImplementation((url) =>
      url.includes('/broken/')
        ? Promise.reject(new Error('broken import'))
        : Promise.resolve(goodModule)
    );

    await loadPlugins({...h, catalogService});

    expect(catalogRequests).toHaveLength(2);
    expect(catalogRequests.some((url) => url.includes('/on/'))).toBe(true);
    expect(catalogRequests.some((url) => url.includes('/broken/'))).toBe(true);
    expect(catalogRequests.some((url) => url.includes('/off/'))).toBe(false);
    expect(catalogRequests.some((url) => url.includes('/pending/'))).toBe(false);
    const brokenState = getPluginLoadState('broken');

    if (brokenState === undefined) {
      throw new Error('broken plugin load state should exist');
    }

    expect(brokenState.label).toBe('broken');
    expect(getPluginManifestPresentation(brokenState, brokenState.catalog, 'en').label).toBe('Translated');
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
    expect(getPluginLoadState('p2')).toMatchObject({runnable: false, status: 'not-runnable'});

    const {routes, pageTable} = buildPluginRoutes(pluginRegistry);

    expect(Object.keys(routes)).toEqual(['/same', '/same/*child']);
    expect(pageTable.pluginNameOf('/same')).toBe('p1');
  });

  it('dismisses the failure toast when the owning auth run logs out', async () => {
    const h = harness([widget('failure')]);

    h.importModule.mockRejectedValue(new Error('broken import'));

    await loadPlugins(h);

    expect(toast.toasts[0]).toMatchObject({key: 'plugin-load', variant: 'error'});

    resetToLogin();

    expect(toast.toasts).toHaveLength(0);
  });

  it('dismisses an in-flight retry on logout and preserves the next auth run toast', async () => {
    const oldHarness = harness([widget('old-failure')]);

    oldHarness.importModule.mockRejectedValueOnce(new Error('broken import'));

    await loadPlugins(oldHarness);

    let finishRetry: (module: unknown) => void = () => {};

    oldHarness.importModule.mockImplementationOnce(() =>
      new Promise((resolve) => {
        finishRetry = resolve;
      })
    );

    const retry = retryPluginLoad('old-failure');

    expect(toast.toasts[0]?.action?.busy).toBe(true);

    resetToLogin();

    expect(toast.toasts).toHaveLength(0);

    beginAuthRun();

    const newHarness = harness([widget('new-failure')]);

    newHarness.importModule.mockRejectedValue(new Error('new broken import'));
    await loadPlugins(newHarness);

    expect(toast.toasts[0]).toMatchObject({
      key: 'plugin-load',
      variant: 'error',
      message: 'Plugins failed to load: new-failure',
    });

    finishRetry(goodModule);
    await retry;

    expect(toast.toasts[0]?.message).toBe('Plugins failed to load: new-failure');
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
    expect(getPluginLoadListOutcome()).toBe('failed');
    expect(pluginRegistry.getAll()).toHaveLength(0);
    expect(toast.toasts).toHaveLength(0);
  });

  it('loads a successful management snapshot after startup list failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const h = harness([]);

    h.fetchList.mockRejectedValueOnce(new Error('network down'));
    await loadPlugins(h);

    expect(getPluginLoadListOutcome()).toBe('failed');
    expect(appState.pluginLoadError).toBe('list');

    await syncPlugins([widget('recovered')]);

    expect(pluginRegistry.get('recovered')).toBeDefined();
    expect(getPluginLoadState('recovered')).toMatchObject({runnable: true, status: 'loaded'});
    expect(getPluginLoadListOutcome()).toBe('ok');
    expect(appState.pluginLoadError).toBeNull();
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
      fetchList: () =>
        new Promise((resolve) => {
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

describe('syncPlugins', () => {
  it('keeps a translated page name after reconciling the plugin list', async () => {
    const registry = new PluginRegistry();
    const entry = page('localized-page', '/localized', {
      label: 'Manifest page',
      i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json', ru: 'i18n/ru.json'}},
    });
    const catalogService = createPluginCatalogService({
      fetchCatalog: (url) =>
        Promise.resolve({
          'manifest.label': url.includes('ru.json') ? 'Локализованная страница' : 'Localized page',
        }),
    });

    await loadPlugins({
      fetchList: () => Promise.resolve([entry]),
      importModule: () => Promise.resolve(goodModule),
      loadStylesheet: () => Promise.resolve(),
      checkVersions: () => [],
      catalogService,
      registry,
      getLocale: () => 'ru',
    });

    await syncPlugins([entry]);

    expect(getPagePluginCandidates(registry).map(({label}) => label)).toEqual(['Локализованная страница']);
  });

  it('increments the successful plugin-list revision on startup and every sync', async () => {
    const revision = getPluginListRevision();

    await loadPlugins(harness([widget('first')]));

    expect(getPluginListRevision()).toBe(revision + 1);

    await syncPlugins([widget('first'), widget('second')]);

    expect(getPluginListRevision()).toBe(revision + 2);

    await syncPlugins([widget('first', {enabled: false}), widget('second')]);

    expect(getPluginListRevision()).toBe(revision + 3);
  });

  it('removes disabled plugins and loads newly enabled plugins without resetting the loader', async () => {
    const h = harness([widget('existing')]);

    await loadPlugins(h);

    const oldPlugin = pluginRegistry.get('existing');
    const synced = syncPlugins([widget('existing', {enabled: false}), widget('newly-enabled')]);

    await expect(synced).resolves.toBe(false);

    expect(pluginRegistry.get('existing')).toBeUndefined();
    expect(pluginRegistry.get('newly-enabled')).toBeDefined();
    expect(getPluginLoadState('existing')).toMatchObject({runnable: false, status: 'not-runnable'});
    expect(h.importModule).toHaveBeenCalledTimes(2);
    expect(oldPlugin).toBeDefined();
  });

  it('keeps a loaded module when list reports a newer version and requests reload', async () => {
    const h = harness([widget('versioned')]);

    await loadPlugins(h);

    const oldPlugin = pluginRegistry.get('versioned');
    const importsBeforeSync = h.importModule.mock.calls.length;

    await expect(syncPlugins([widget('versioned', {version: '2.0.0'})])).resolves.toBe(true);

    expect(pluginRegistry.get('versioned')).toBe(oldPlugin);
    expect(getPluginLoadState('versioned')).toMatchObject({runnable: true, status: 'loaded'});
    expect(h.importModule).toHaveBeenCalledTimes(importsBeforeSync);
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
