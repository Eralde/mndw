// @vitest-environment happy-dom
import 'zone.js';
import '@angular/compiler';
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
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mountWidgetTile} from '../dashboard/widget-mount.js';
import {appState} from '../state/app.svelte.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {pluginRegistry} from './plugin-registry.js';
import {createTestPluginContext} from './test-plugin-context.js';
import {mountPlugin, unmountPlugin} from './plugin-lifecycle.js';
import type {PageListEntry, PluginListEntry, WidgetListEntry} from './plugin-types.js';

const pageContexts = vi.hoisted(() => new Map<string, PluginContext>());
const tileTitles = vi.hoisted(() => new Map<string, string>());

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
        : {
          kind: 'widget' as const,
          setTileTitle: setTileTitle ?? ((title: string) => tileTitles.set(entry.name, title)),
        };

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
const EXPECTED_PLUGINS = ['mws-page', 'tx-rx-chart-widget'] as const;

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
  const manifest = packedManifests[`${PACKED_GLOB}/${name}/manifest.json`];

  if (packedModules[`${PACKED_GLOB}/${name}/index.js`] === undefined || manifest?.i18n === undefined) {
    return false;
  }

  return Object.values(manifest.i18n.locales).every((path) =>
    packedCatalogFiles[`${PACKED_GLOB}/${name}/${path}`] !== undefined
  );
});

if (!packedReady) {
  console.warn('Skipping built-in Angular l10n smoke: packed dist missing; run pnpm build-builtin-plugins first.');
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

  return {...base, type: 'widget', size: manifest.size ?? {w: 4, h: 3}} as WidgetListEntry;
}

function createSmokeContext(i18n: PluginContext['i18n'], setTileTitle?: (title: string) => void): PluginContext {
  const queue = vi.fn((query: {path?: string}) => {
    switch (query.path) {
      case 'show.identification':
        return of({servicetag: 'TEST', serial: 'TEST', mac: '00:00', hwid: 'TEST', cid: 'TEST'});
      case 'show.system':
        return of({model: 'Test Router', uptime: 1, cpuload: 1, memtotal: 100, memory: '1/100'});
      case 'show.version':
        return of({model: 'Test Router', description: 'Test Controller', title: '1.0'});
      case 'show.system.rrd.cpu':
      case 'show.system.rrd.memory':
        return of({data: []});
      case 'show.mws.member':
        return of([]);
      case 'show.device-list':
        return of({host: []});
      case 'show.interface':
        return of({mac: '00:11:22:33:44:55', state: 'up'});
      default:
        return of({});
    }
  });
  const backend: BackendClient = {
    fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({success: true, data: []})))),
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
      initBackgroundProcess: vi.fn(() => ({data$: of({data: []}), abort: vi.fn()})),
      queueBackgroundProcess: vi.fn(() => ({data$: of({data: []}), abort: vi.fn()})),
    } as unknown as PluginContext['rciManager'],
    setTileTitle,
  });
}

async function stabilizeAngular(rounds = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function queryDeep(root: ParentNode, selector: string): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(selector);

  if (direct !== null) {
    return direct;
  }

  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot !== null) {
      const nested = queryDeep(element.shadowRoot, selector);

      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

class SmokeWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(_url: URL, _options?: WorkerOptions) {}

  public postMessage(_message: unknown): void {}

  public terminate(): void {}
}

class SmokeMutationObserver {
  constructor(_callback: MutationCallback) {}

  public observe(_target: Node, _options?: MutationObserverInit): void {}

  public disconnect(): void {}

  public takeRecords(): MutationRecord[] {
    return [];
  }
}

const smoke = packedReady ? describe : describe.skip;

afterEach(() => {
  vi.unstubAllGlobals();
  pluginRegistry.clear();
  replaceDepsStatuses([]);
  pageContexts.clear();
  tileTitles.clear();
  appState.hostInfo = null;
  document.body.innerHTML = '';
});

smoke('packed Angular built-in l10n smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', SmokeWorker);
    vi.stubGlobal('MutationObserver', SmokeMutationObserver);
    defineMndwUi();
    appState.hostInfo = {
      deviceName: 'Smoke Router',
      vendor: 'Smoke Vendor',
      firmwareVersion: '1.0.0',
      locale: 'en',
      theme: 'dark',
    };
  });

  it('switches tx-rx-chart-widget without remounting', async () => {
    const en = packedCatalog('tx-rx-chart-widget', 'en');
    const ru = packedCatalog('tx-rx-chart-widget', 'ru');
    const enValue = en['l10n.probe'];
    const ruValue = ru['l10n.probe'];

    expect(enValue).not.toBe(ruValue);

    const testI18n: TestI18n = createTestI18n(en);
    const loaded = {entry: pluginEntry('tx-rx-chart-widget'), module: await packedModule('tx-rx-chart-widget')};
    const container = document.createElement('div');

    document.body.append(container);

    const handle = mountWidgetTile(container, loaded, createSmokeContext(testI18n));

    expect(await handle.whenReady()).toBe(true);
    await stabilizeAngular(4);

    const probe = container.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

    expect(probe?.textContent).toBe(enValue);
    testI18n.setLocale('ru', ru);
    await stabilizeAngular();
    expect(container.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe(ruValue);

    handle.dispose();
    expect(container.childElementCount).toBe(0);
  });

  it('switches mws-page root and child without remounting and updates tile labels', async () => {
    const en = packedCatalog('mws-page', 'en');
    const ru = packedCatalog('mws-page', 'ru');
    const enValue = en['l10n.probe'];
    const ruValue = ru['l10n.probe'];

    expect(enValue).not.toBe(ruValue);

    const testI18n: TestI18n = createTestI18n(en);
    const loaded = {entry: pluginEntry('mws-page'), module: await packedModule('mws-page')};

    pluginRegistry.register(loaded);

    const target = document.createElement('div');

    document.body.append(target);

    const context = createSmokeContext(testI18n, (title) => tileTitles.set('mws-page', title));
    const mounted = mountPlugin(target, loaded, context);

    if (mounted === null || mounted instanceof Promise) {
      throw new Error('MWS packed smoke mount did not settle synchronously');
    }

    await stabilizeAngular(4);

    const rootProbe = queryDeep(target, '[data-testid="l10n-probe"]');
    const childProbe = queryDeep(target, '[data-testid="l10n-child-probe"]');

    expect(rootProbe?.textContent).toBe(enValue);
    expect(childProbe).not.toBeNull();
    expect(tileTitles.get('mws-page')).toBe(en.title);
    testI18n.setLocale('ru', ru);
    await stabilizeAngular();

    expect(queryDeep(target, '[data-testid="l10n-probe"]')).toBe(rootProbe);
    expect(queryDeep(target, '[data-testid="l10n-child-probe"]')).toBe(childProbe);
    expect(rootProbe?.textContent).toBe(ruValue);
    expect(childProbe?.textContent).toBe(ruValue);
    expect(tileTitles.get('mws-page')).toBe(ru.title);

    unmountPlugin(mounted, target);
    expect(target.childElementCount).toBe(0);
  });
});
