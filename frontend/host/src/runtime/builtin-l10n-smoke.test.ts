// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import type {
  BackendClient,
  BackendRouteDescriptor,
  HostInfo,
  MndwPlugin,
  PluginContext,
  PluginManifestI18n,
} from '@mndw/sdk';
import {type PluginCatalog, parseCatalog} from '@mndw/sdk/catalog';
import {type TestI18n, createTestI18n} from '@mndw/sdk/testing';
import {of} from 'rxjs';
import {flushSync, mount, unmount} from 'svelte';
import {nextTick} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createTestPluginContext} from './test-plugin-context.js';
import {mountWidgetTile} from '../dashboard/widget-mount.js';
import {appState} from '../state/app.svelte.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {createAppRouter} from '../router/create-app-router.js';
import PagePluginHost from '../pages/PagePluginHost.svelte';
import {pluginRegistry} from './plugin-registry.js';
import type {PageListEntry, PluginListEntry, WidgetListEntry} from './plugin-types.js';

const pageContexts = vi.hoisted(() => new Map<string, PluginContext>());

vi.mock('./plugin-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugin-context.js')>();

  return {
    ...actual,
    createPluginContext: vi.fn((
      entry: {name: string; type: 'widget' | 'page'},
      instanceId: string,
      hostInfo: HostInfo,
      setTileTitle: ((title: string) => void) | undefined,
      pageRoute: PluginContext['pageRoute'],
    ) => {
      const template = pageContexts.get(entry.name);

      if (template === undefined) {
        throw new Error(`No smoke context for ${entry.name}`);
      }

      const variant = entry.type === 'page'
        ? {kind: 'page' as const, pageRoute}
        : {kind: 'widget' as const, setTileTitle};

      return Object.freeze({
        ...template,
        hostInfo,
        instanceId,
        ...variant,
      }) as PluginContext;
    }),
  };
});

const PACKED_GLOB = '../../../../plugins/builtin/dist';
const EXPECTED_PLUGINS = [
  'backend-echo',
  'clients-widget',
  'clock-widget',
  'demo-page',
  'device-info-widget',
  'device-traffic-widget',
  'dns-lookup-widget',
  'ping-widget',
  'system-log-page',
  'terminal-page',
] as const;
const VUE_PLUGINS = new Set(['clients-widget', 'device-info-widget']);

interface PackedManifest {
  name: string;
  version: string;
  label: string;
  entry: string;
  type: 'widget' | 'page';
  route?: string;
  size?: WidgetListEntry['size'];
  i18n?: PluginManifestI18n;
  backend?: {
    routes?: Array<{
      id: string;
      transport: 'http' | 'websocket';
      path: string;
      method?: BackendRouteDescriptor['method'];
    }>;
  };
}

interface PackedModule {
  createInstance: MndwPlugin['createInstance'];
}

const packedModules = import.meta.glob<PackedModule>('../../../../plugins/builtin/dist/*/index.js');
const packedManifests = import.meta.glob<PackedManifest>('../../../../plugins/builtin/dist/*/manifest.json', {
  eager: true,
  import: 'default',
});
const packedCatalogFiles = import.meta.glob<Record<string, unknown>>('../../../../plugins/builtin/dist/*/i18n/*.json', {
  eager: true,
  import: 'default',
});

const packedReady = EXPECTED_PLUGINS.every((name) => {
  const moduleKey = `${PACKED_GLOB}/${name}/index.js`;
  const manifestKey = `${PACKED_GLOB}/${name}/manifest.json`;
  const manifest = packedManifests[manifestKey];

  if (packedModules[moduleKey] === undefined || manifest?.i18n === undefined) {
    return false;
  }

  return Object.values(manifest.i18n.locales).every((path) =>
    packedCatalogFiles[`${PACKED_GLOB}/${name}/${path}`] !== undefined
  );
});

if (!packedReady) {
  console.warn('Skipping built-in l10n smoke: packed dist missing; run pnpm build-builtin-plugins first.');
}

function packedManifest(name: string): PackedManifest {
  const manifest = packedManifests[`${PACKED_GLOB}/${name}/manifest.json`];

  if (manifest === undefined) {
    throw new Error(`Missing packed manifest for ${name}`);
  }

  return manifest;
}

async function packedModule(name: string): Promise<PackedModule> {
  const loader = packedModules[`${PACKED_GLOB}/${name}/index.js`];

  if (loader === undefined) {
    throw new Error(`Missing packed module for ${name}`);
  }

  return loader();
}

function packedCatalog(name: string, locale: 'en' | 'ru'): PluginCatalog {
  const manifest = packedManifest(name);
  const path = manifest.i18n?.locales[locale];

  if (path === undefined) {
    throw new Error(`Packed plugin ${name} does not declare ${locale}`);
  }

  const catalog = packedCatalogFiles[`${PACKED_GLOB}/${name}/${path}`];

  if (catalog === undefined) {
    throw new Error(`Missing packed catalog for ${name}/${locale}`);
  }

  return parseCatalog(catalog, `${name}/${locale}`);
}

function backendDescriptor(manifest: PackedManifest): PluginListEntry['backend'] {
  return {
    routes: Object.fromEntries((manifest.backend?.routes ?? []).map((route) => [route.id, {
      transport: route.transport,
      path: route.path,
      ...(route.method === undefined ? {} : {method: route.method}),
    }])),
  };
}

function pluginEntry(name: string): PluginListEntry {
  const manifest = packedManifest(name);
  const base = {
    name: manifest.name,
    version: manifest.version,
    label: manifest.label,
    entry: manifest.entry,
    source: 'builtin' as const,
    approval: 'approved' as const,
    enabled: true,
    depsStatus: 'ready' as const,
    backend: backendDescriptor(manifest),
    i18n: manifest.i18n,
  };

  if (manifest.type === 'page') {
    if (manifest.route === undefined) {
      throw new Error(`Packed page ${name} has no route`);
    }

    return {...base, type: 'page', route: manifest.route} as PageListEntry;
  }

  return {
    ...base,
    type: 'widget',
    size: manifest.size ?? {w: 4, h: 3},
  } as WidgetListEntry;
}

function createSmokeContext(i18n: PluginContext['i18n']): PluginContext {
  const queue = vi.fn((query: {path?: string}) => {
    switch (query.path) {
      case 'show.identification':
        return of({servicetag: 'TEST', serial: 'TEST', mac: '00:00', hwid: 'TEST', cid: 'TEST'});
      case 'show.system':
        return of({model: 'Test Router', uptime: 1, cpuload: 1, memtotal: 100, memory: '1/100'});
      case 'show.version':
        return of({model: 'Test Router', version: '1.0'});
      case 'show.system.rrd.cpu':
      case 'show.system.rrd.memory':
        return of({data: []});
      case 'show.log':
        return of({data: []});
      default:
        return of({});
    }
  });
  const queueBackgroundProcess = vi.fn(() => ({data$: of({data: []}), abort: vi.fn()}));
  const backend: BackendClient = {
    fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({success: true, data: []})))),
    status: vi.fn(() => Promise.resolve({kind: 'exec', state: 'ready', retryAfterSeconds: null} as const)),
    socket: vi.fn(() => {
      throw new Error('Smoke test socket was not expected');
    }),
  };

  return createTestPluginContext({
    i18n,
    backend,
    rciManager: {
      execute: queue,
      queue,
      initBackgroundProcess: queueBackgroundProcess,
      queueBackgroundProcess,
    } as unknown as PluginContext['rciManager'],
  });
}

async function flushPlugin(name: string): Promise<void> {
  await Promise.resolve();

  if (VUE_PLUGINS.has(name)) {
    await nextTick();

    return;
  }

  flushSync();
}

const smoke = packedReady ? describe : describe.skip;

class SmokeWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(_url: URL, _options?: WorkerOptions) {}

  public postMessage(_message: unknown): void {}

  public terminate(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  pluginRegistry.clear();
  replaceDepsStatuses([]);
  pageContexts.clear();
  appState.hostInfo = null;
  document.body.innerHTML = '';
});

smoke('packed built-in l10n smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', SmokeWorker);
    defineMndwUi();
    appState.hostInfo = {
      deviceName: 'Smoke Router',
      vendor: 'Smoke Vendor',
      firmwareVersion: '1.0.0',
      locale: 'en',
      theme: 'dark',
    };
  });

  it.each(EXPECTED_PLUGINS)('switches %s without remounting', async (name) => {
    const en = packedCatalog(name, 'en');
    const ru = packedCatalog(name, 'ru');
    const probeKey = 'l10n.probe';
    const enValue = en[probeKey];
    const ruValue = ru[probeKey];

    expect(enValue).toBeTypeOf('string');
    expect(ruValue).toBeTypeOf('string');
    expect(enValue).not.toBe(ruValue);

    const testI18n: TestI18n = createTestI18n(en);
    const loaded = {entry: pluginEntry(name), module: await packedModule(name)};

    if (loaded.entry.type === 'widget') {
      const container = document.createElement('div');

      document.body.append(container);

      const context = createSmokeContext(testI18n);
      const handle = mountWidgetTile(container, loaded, context);

      expect(await handle.whenReady()).toBe(true);
      await flushPlugin(name);

      const probe = container.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

      expect(probe).not.toBeNull();
      expect(probe?.textContent).toBe(enValue);
      testI18n.setLocale('ru', ru);
      await flushPlugin(name);
      expect(container.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
      expect(probe?.textContent).toBe(ruValue);

      handle.dispose();
      expect(container.childElementCount).toBe(0);

      return;
    }

    const context = createSmokeContext(testI18n);

    pageContexts.set(name, context);
    pluginRegistry.register(loaded);
    replaceDepsStatuses([loaded.entry]);

    const router = createAppRouter();

    await router.navigate(loaded.entry.route as `/${string}`);

    const target = document.createElement('div');

    document.body.append(target);

    const component = mount(PagePluginHost, {target});

    flushSync();
    await flushPlugin(name);

    const probe = target.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

    expect(probe).not.toBeNull();
    expect(probe?.textContent).toBe(enValue);
    testI18n.setLocale('ru', ru);
    await flushPlugin(name);
    expect(target.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe(ruValue);

    void unmount(component);
    await router.navigate('/');
  });
});
