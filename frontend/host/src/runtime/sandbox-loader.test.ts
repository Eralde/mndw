// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type LoadedPlugin, PluginRegistry} from './plugin-registry.js';
import {
  type SandboxLoaderDeps,
  loadSandboxPlugin,
  manifestToListEntry,
  reloadSandboxPlugin,
  retrySandboxPlugin,
} from './sandbox-loader.js';
import {createPluginCatalogService} from '../services/plugin-catalog.service.js';
import {createHostServices} from '../host-services.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus, replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {getPagePluginCandidates} from './page-plugin-candidates.js';
import {pluginStylesheets} from './plugin-stylesheets.js';
import {
  applyPluginListSnapshot,
  getPluginLoadListOutcome,
  getPluginLoadState,
  replacePluginLoadStates,
  setPluginLoadListOutcome,
} from './plugin-load-state.svelte.js';

const widgetManifest = {
  manifestVersion: 1,
  name: 'sandbox-widget',
  version: '0.0.0',
  type: 'widget',
  label: 'Sandbox Widget',
  entry: 'index.js',
  size: {w: 4, h: 3, minW: 2, minH: 2},
};

const pageManifest = {
  manifestVersion: 1,
  name: 'sandbox-page',
  version: '0.0.0',
  type: 'page',
  label: 'Sandbox Page',
  entry: 'index.js',
  route: '/sandbox',
};

const backendManifest = {
  ...widgetManifest,
  backend: {
    kind: 'exec',
    routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello', command: 'backend/main.sh'}],
  },
};

const sandboxModule = {createInstance: () => ({unmount: () => {}})};

function deps(overrides: Partial<SandboxLoaderDeps> = {}): SandboxLoaderDeps {
  const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});

  return {
    importPluginModule: () => Promise.resolve(sandboxModule),
    importManifestModule: () => Promise.resolve({default: widgetManifest}),
    registry: new PluginRegistry() as unknown as SandboxLoaderDeps['registry'],
    catalogService: services.catalog,
    getLocale: () => services.locale.getLocale(),
    pluginContextServices: {
      locale: services.locale,
      palette: services.palette,
      telemetry: services.telemetry,
      telemetryGathering: services.telemetryGathering,
      eventStream: services.eventStream,
      navigation: () => ({
        pageTable: {baseRouteOf: () => undefined, pluginNameOf: () => undefined},
        navigate: () => undefined,
      }),
    },
    remountWidgets: vi.fn(() => Promise.resolve(true)),
    reloadPage: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (window as unknown as {happyDOM: {settings: {disableCSSFileLoading: boolean}}})
    .happyDOM.settings.disableCSSFileLoading = true;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  replacePluginLoadStates([]);
  setPluginLoadListOutcome('pending');
  replaceDepsStatuses([]);
});

afterEach(() => {
  replacePluginLoadStates([]);
  setPluginLoadListOutcome('pending');
  replaceDepsStatuses([]);
  vi.restoreAllMocks();
});

describe('manifestToListEntry', () => {
  it('derives an approved+enabled builtin widget entry with an empty backend descriptor', () => {
    const entry = manifestToListEntry(widgetManifest as never);

    expect(entry).toMatchObject({
      name: 'sandbox-widget',
      type: 'widget',
      source: 'builtin',
      approval: 'approved',
      enabled: true,
      size: {w: 4, h: 3, minW: 2, minH: 2},
      backend: {routes: {}},
    });
  });

  it('derives a page entry with its route', () => {
    const entry = manifestToListEntry(pageManifest as never);

    expect(entry).toMatchObject({type: 'page', route: '/sandbox'});
  });

  it('maps declared backend routes into the descriptor', () => {
    const entry = manifestToListEntry(backendManifest as never);

    expect(entry.backend).toMatchObject({
      routes: {hello: {transport: 'http', method: 'GET', path: 'hello'}},
    });
  });

  it('passes the manifest catalog descriptor and dev-served base through the boundary', () => {
    const entry = manifestToListEntry({
      ...widgetManifest,
      i18n: {defaultLocale: 'en', locales: {en: 'i18n/en.json'}},
    } as never, '/@fs/repo/plugins/demo');

    expect(entry.i18n).toEqual({defaultLocale: 'en', locales: {en: 'i18n/en.json'}});
    expect(entry.catalogBaseUrl).toBe('/@fs/repo/plugins/demo');
  });
});

describe('loadSandboxPlugin dashboard state', () => {
  it('publishes a successful single-plugin list and loaded state', async () => {
    const registry = new PluginRegistry();

    await loadSandboxPlugin(deps({registry}));

    expect(getPluginLoadListOutcome()).toBe('ok');
    expect(getPluginLoadState('sandbox-widget')).toMatchObject({
      runnable: true,
      status: 'loaded',
      type: 'widget',
      label: 'Sandbox Widget',
      size: {w: 4, h: 3, minW: 2, minH: 2},
    });
    expect(getDepsStatus('sandbox-widget')).toBe('ready');
  });

  it('keeps list outcome successful when a valid sandbox plugin module fails to load', async () => {
    const registry = new PluginRegistry();
    let module: unknown = {};

    await loadSandboxPlugin(deps({
      registry,
      importPluginModule: () => Promise.resolve(module),
    }));

    expect(getPluginLoadListOutcome()).toBe('ok');
    expect(getPluginLoadState('sandbox-widget')).toMatchObject({
      runnable: true,
      status: 'failed',
      type: 'widget',
      label: 'Sandbox Widget',
    });
    expect(registry.getAll()).toHaveLength(0);

    module = sandboxModule;

    await expect(retrySandboxPlugin('sandbox-widget')).resolves.toBe(true);

    expect(getPluginLoadState('sandbox-widget')?.status).toBe('loaded');
    expect(registry.get('sandbox-widget')?.module).toBe(sandboxModule);
  });

  it('does not let an older retry overwrite a successful HMR commit', async () => {
    const registry = new PluginRegistry();
    let rejectRetry: ((error: Error) => void) | undefined;
    let retryImportStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      retryImportStarted = resolve;
    });
    let importCount = 0;
    const run = deps({
      registry,
      importPluginModule: () => {
        importCount += 1;

        if (importCount === 1) {
          return Promise.resolve({});
        }

        return new Promise((_resolve, reject) => {
          rejectRetry = reject;
          retryImportStarted();
        });
      },
    });

    await loadSandboxPlugin(run);

    const retry = retrySandboxPlugin('sandbox-widget');

    await retryStarted;

    const hotModule = {createInstance: () => ({unmount: () => {}})};
    const reload = await reloadSandboxPlugin(deps({
      registry,
      importPluginModule: () => Promise.resolve(hotModule),
    }));

    expect(reload).toBe('reloaded');
    expect(getPluginLoadState('sandbox-widget')?.status).toBe('loaded');

    rejectRetry?.(new Error('stale retry failed'));
    await expect(retry).resolves.toBe(false);

    expect(registry.get('sandbox-widget')?.module).toBe(hotModule);
    expect(getPluginLoadState('sandbox-widget')?.status).toBe('loaded');
  });

  it('does not reset or publish plugin state for a superseded sandbox run', async () => {
    const registry = new PluginRegistry();

    applyPluginListSnapshot([manifestToListEntry(widgetManifest as never)]);
    setPluginLoadListOutcome('failed');

    await loadSandboxPlugin(deps({
      registry,
      isCurrent: () => false,
    }));

    expect(getPluginLoadListOutcome()).toBe('failed');
    expect(getPluginLoadState('sandbox-widget')).toBeDefined();
    expect(registry.getAll()).toHaveLength(0);
  });
});

describe('loadSandboxPlugin', () => {
  it('updates sandbox page candidate labels after a locale switch', async () => {
    const catalogService = createPluginCatalogService({
      fetchCatalog: (url) =>
        Promise.resolve({
          'manifest.label': url.includes('ru.json') ? 'Страница песочницы' : 'Sandbox page',
        }),
    });
    const registry = new PluginRegistry({catalog: catalogService});

    appState.locale = 'en';

    await loadSandboxPlugin(deps({
      registry,
      catalogService,
      importManifestModule: () =>
        Promise.resolve({
          default: {
            ...pageManifest,
            label: 'Sandbox page',
            i18n: {defaultLocale: 'en', locales: {en: 'en.json', ru: 'ru.json'}},
          },
        }),
    }));

    expect(getPagePluginCandidates(registry).map(({label}) => label)).toEqual(['Sandbox page']);

    const generation = catalogService.preparePluginCatalogGeneration('ru');

    await generation.promise;
    catalogService.commitPluginCatalogGeneration(generation, () => {
      appState.locale = 'ru';
    });

    expect(getPagePluginCandidates(registry).map(({label}) => label)).toEqual(['Страница песочницы']);
  });

  it('uses the injected catalog service and locale', async () => {
    const registry = new PluginRegistry();
    const catalogService = createPluginCatalogService({
      fetchCatalog: () => Promise.resolve({title: 'Hello'}),
    });
    const createCell = vi.spyOn(catalogService, 'createPluginCatalogCell');
    const getLocale = vi.fn(() => 'ru');

    await loadSandboxPlugin(deps({
      registry,
      catalogService,
      getLocale,
      importManifestModule: () =>
        Promise.resolve({
          default: {
            ...widgetManifest,
            i18n: {defaultLocale: 'en', locales: {en: 'en.json', ru: 'ru.json'}},
          },
        }),
    }));

    expect(createCell).toHaveBeenCalledWith(expect.anything(), 'ru');
    expect(getLocale).toHaveBeenCalled();
  });

  it('validates and registers the sandbox plugin from the virtual modules', async () => {
    const registry = new PluginRegistry();

    await loadSandboxPlugin(deps({registry: registry as never}));

    expect(registry.get('sandbox-widget')?.entry.type).toBe('widget');
    expect(registry.get('sandbox-widget')?.module).toBe(sandboxModule);
  });

  it('drops a sandbox result superseded while modules load', async () => {
    const registry = new PluginRegistry();

    await loadSandboxPlugin(deps({
      registry: registry as never,
      isCurrent: () => false,
    }));

    expect(registry.getAll()).toHaveLength(0);
  });

  it('does not register when the manifest is invalid (fails visibly)', async () => {
    const registry = new PluginRegistry();

    await loadSandboxPlugin(deps({
      registry: registry as never,
      importManifestModule: () => Promise.resolve({default: {...widgetManifest, name: 'Bad Name!'}}),
    }));

    expect(registry.getAll()).toHaveLength(0);
    expect(getPluginLoadListOutcome()).toBe('failed');
    expect(getPluginLoadState('sandbox-widget')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not register when the module lacks createInstance', async () => {
    const registry = new PluginRegistry();

    await loadSandboxPlugin(deps({
      registry: registry as never,
      importPluginModule: () => Promise.resolve({}),
    }));

    expect(registry.getAll()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('reloadSandboxPlugin', () => {
  function seed(registry: PluginRegistry, priorModule = {createInstance: () => ({unmount: () => {}})}): LoadedPlugin {
    const plugin = {entry: manifestToListEntry(widgetManifest as never), module: priorModule};

    registry.register(plugin);

    return plugin;
  }

  it('replaces the registry module and remounts widgets on a compatible reload', async () => {
    const registry = new PluginRegistry();
    const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
    const pluginContextServices = {
      locale: services.locale,
      palette: services.palette,
      telemetry: services.telemetry,
      telemetryGathering: services.telemetryGathering,
      eventStream: services.eventStream,
      navigation: () => ({
        pageTable: {baseRouteOf: () => undefined, pluginNameOf: () => undefined},
        navigate: () => undefined,
      }),
    };

    seed(registry);

    const remountWidgets = vi.fn(() => Promise.resolve(true));

    const result = await reloadSandboxPlugin(deps({
      registry: registry as never,
      remountWidgets,
      pluginContextServices,
    }));

    expect(result).toBe('reloaded');
    expect(registry.get('sandbox-widget')?.module).toBe(sandboxModule);
    expect(remountWidgets).toHaveBeenCalledWith(
      'sandbox-widget',
      expect.anything(),
      expect.anything(),
      registry,
      pluginContextServices,
    );
  });

  it('remounts the page for a page-type sandbox plugin', async () => {
    const registry = new PluginRegistry();
    const prior = {entry: manifestToListEntry(pageManifest as never),
      module: {createInstance: () => ({unmount: () => {}})}};

    registry.register(prior);

    const reloadPage = vi.fn(() => Promise.resolve(true));

    const result = await reloadSandboxPlugin(deps({
      registry: registry as never,
      importManifestModule: () => Promise.resolve({default: pageManifest}),
      reloadPage,
    }));

    expect(result).toBe('reloaded');
    expect(reloadPage).toHaveBeenCalledWith('sandbox-page', expect.anything(), expect.anything());
  });

  it('requires a restart on a topology-changing manifest and keeps the prior plugin live', async () => {
    const registry = new PluginRegistry();
    const prior = seed(registry);

    // Same plugin name, but the type flips widget -> page (a topology change).
    const topologyChange = {...pageManifest, name: 'sandbox-widget', route: '/sandbox-widget'};

    const result = await reloadSandboxPlugin(deps({
      registry: registry as never,
      importManifestModule: () => Promise.resolve({default: topologyChange}),
    }));

    expect(result).toBe('restart-required');
    expect(registry.get('sandbox-widget')?.module).toBe(prior.module);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps the prior module when the candidate manifest is invalid', async () => {
    const registry = new PluginRegistry();
    const prior = seed(registry);

    const result = await reloadSandboxPlugin(deps({
      registry: registry as never,
      importManifestModule: () => Promise.resolve({default: {...widgetManifest, name: 'Bad Name!'}}),
    }));

    expect(result).toBe('failed');
    expect(registry.get('sandbox-widget')?.module).toBe(prior.module);
  });

  it('rolls the registry back to the prior module when a remount reports failure', async () => {
    const registry = new PluginRegistry();
    const prior = seed(registry);

    const result = await reloadSandboxPlugin(deps({
      registry: registry as never,
      remountWidgets: vi.fn(() => Promise.resolve(false)),
    }));

    expect(result).toBe('failed');
    expect(registry.get('sandbox-widget')?.module).toBe(prior.module);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps prior version CSS through failed reload and rollback', async () => {
    const registry = new PluginRegistry();
    const priorEntry = manifestToListEntry({...widgetManifest, version: '0.0.1'} as never);
    const priorStylesheet = pluginStylesheets.acquire(
      priorEntry.name,
      priorEntry.version,
      `/plugins/${priorEntry.name}/index.css?v=${priorEntry.version}`,
    );
    const priorLink = document.head.querySelector<HTMLLinkElement>(
      `link[data-plugin-style="${priorEntry.name}"]`,
    );

    if (priorLink === null) {
      throw new Error('Prior stylesheet was not added');
    }

    priorLink.dispatchEvent(new Event('load'));
    registry.register({
      entry: priorEntry,
      module: {createInstance: () => ({unmount: () => {}})},
      stylesheetLease: priorStylesheet,
    });

    let finishRemount: (success: boolean) => void = () => {};
    const remounting = new Promise<boolean>((resolve) => {
      finishRemount = resolve;
    });
    const transaction = reloadSandboxPlugin(deps({
      registry: registry as never,
      importManifestModule: () => Promise.resolve({default: {...widgetManifest, version: '0.0.2'}}),
      remountWidgets: () => remounting,
    }));

    try {
      await vi.waitFor(() => expect(registry.get('sandbox-widget')?.entry.version).toBe('0.0.2'));
      expect(priorLink.isConnected).toBe(true);

      finishRemount(false);
      await expect(transaction).resolves.toBe('failed');

      expect(registry.get('sandbox-widget')?.module).not.toBe(sandboxModule);
      expect(registry.get('sandbox-widget')?.entry.version).toBe('0.0.1');
      expect(priorLink.isConnected).toBe(true);
    } finally {
      finishRemount(false);
      registry.clear();
    }
  });
});
