import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type LoadedPlugin, PluginRegistry} from './plugin-registry.js';
import {type SandboxLoaderDeps, loadSandboxPlugin, manifestToListEntry, reloadSandboxPlugin} from './sandbox-loader.js';
import {createPluginCatalogService} from '../services/plugin-catalog.service.js';
import {createHostServices} from '../host-services.js';

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
  return {
    importPluginModule: () => Promise.resolve(sandboxModule),
    importManifestModule: () => Promise.resolve({default: widgetManifest}),
    registry: new PluginRegistry() as unknown as SandboxLoaderDeps['registry'],
    remountWidgets: vi.fn(() => Promise.resolve(true)),
    reloadPage: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
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

  it('forwards fixedHeight for dev-mode widget manifests', () => {
    const entry = manifestToListEntry({...widgetManifest, fixedHeight: true} as never);

    expect(entry).toMatchObject({type: 'widget', fixedHeight: true});
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

describe('loadSandboxPlugin', () => {
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

  it('does not register when the manifest is invalid (fails visibly)', async () => {
    const registry = new PluginRegistry();

    await loadSandboxPlugin(deps({
      registry: registry as never,
      importManifestModule: () => Promise.resolve({default: {...widgetManifest, name: 'Bad Name!'}}),
    }));

    expect(registry.getAll()).toHaveLength(0);
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
    const services = createHostServices();

    seed(registry);

    const remountWidgets = vi.fn(() => Promise.resolve(true));

    const result = await reloadSandboxPlugin(deps({
      registry: registry as never,
      remountWidgets,
      pluginContextServices: {locale: services.locale, palette: services.palette},
    }));

    expect(result).toBe('reloaded');
    expect(registry.get('sandbox-widget')?.module).toBe(sandboxModule);
    expect(remountWidgets).toHaveBeenCalledWith(
      'sandbox-widget',
      expect.anything(),
      expect.anything(),
      registry,
      {locale: services.locale, palette: services.palette},
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

    // Same plugin name, but the type flips widget → page (a topology change).
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
});
