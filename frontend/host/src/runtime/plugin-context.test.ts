import {MNDW_TOKENS, PageRouteError, type PaletteTokenMap} from '@mndw/sdk';
import {of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {createPluginContext} from './plugin-context.js';
import {createPluginCatalogService} from '../services/plugin-catalog.service.js';
import {localeService} from '../services/locale.service.js';
import {paletteService} from '../services/palette.service.js';
import type {PageListEntry, PluginBackendDescriptor, WidgetListEntry} from './plugin-types.js';

vi.mock('../services/rci.service.js', () => ({
  rciService: {
    driver: {
      execute: vi.fn(() => 'exec-result'),
      queue: vi.fn(),
      initBackgroundProcess: vi.fn(),
      queueBackgroundProcess: vi.fn(),
    },
  },
}));
vi.mock('../services/storage.service.js', () => ({
  ScopedPluginStorage: class {
    constructor(_prefix: string) {}
  },
}));
vi.mock('../services/theme.service.js', () => ({
  getTheme: () => 'dark',
  subscribeTheme: () => () => {},
}));
vi.mock('../services/overlay/overlay-manager.svelte.js', () => ({
  createPluginOverlayService: vi.fn(() => ({
    service: {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()},
    dispose: vi.fn(),
  })),
}));

const hostInfo = {locale: 'en', theme: 'dark'} as const;
const deviceInfo = {
  deviceName: 'Device',
  vendor: 'Vendor',
  manufacturer: 'Vendor',
  model: 'Model',
  series: 'Series',
  region: 'WW',
  hwId: 'id',
  hwVersion: '1',
  firmwareVersion: '1.0',
  firmwareRelease: '1.0',
  features: [],
  components: [],
  switchports: {list: [], layout: [], hasPortStats: false},
  usb: {ports: []},
} as const;

const emptyBackend: PluginBackendDescriptor = {
  routes: {},
};

function widgetEntry(backend: PluginBackendDescriptor = emptyBackend): WidgetListEntry {
  return {
    name: 'demo',
    type: 'widget',
    version: '1.0.0',
    label: 'Demo',
    entry: 'index.js',
    source: 'upload',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    size: {w: 4, h: 3},
    backend,
  };
}

function pageEntry(): PageListEntry {
  return {
    ...widgetEntry(),
    type: 'page',
    route: '/demo',
  };
}

describe('createPluginContext', () => {
  it('exposes a frozen synchronous translator backed by the host catalog cell', () => {
    const cell = createPluginCatalogService().createPluginCatalogCell({
      name: 'demo',
      version: '1.0.0',
      baseUrl: '/plugins/demo',
      defaultLocale: 'en',
      locales: {en: 'i18n/en.json'},
    }, 'en');

    cell.commit({
      hostLocale: 'en',
      resolvedCatalogLocale: 'en',
      primaryCatalog: {title: 'Hello {name}'},
      defaultCatalog: {fallback: 'Fallback'},
      fallbackStatus: 'primary',
    });

    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo,
      catalogCell: cell});

    expect(ctx.kind).toBe('widget');
    expect(ctx.i18n.t('title', {name: 'Ada'})).toBe('Hello Ada');
    expect(ctx.i18n.t('missing')).toBe('missing');
    expect(Object.isFrozen(ctx.i18n)).toBe(true);
  });

  it('exposes stable page-route errors', () => {
    const error = new PageRouteError('INVALID_PATH', 'invalid child path');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PageRouteError');
    expect(error.code).toBe('INVALID_PATH');
  });

  it('attaches the overlay service', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(ctx.overlay).toBeDefined();
    expect(typeof ctx.overlay.createLayer).toBe('function');
    expect(typeof ctx.overlay.open).toBe('function');
    expect(typeof ctx.overlay.closeAll).toBe('function');
  });

  it('omits backend when the plugin declares nothing callable', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(ctx.backend).toBeUndefined();
  });

  it('wires a backend client when HTTP routes are declared', () => {
    const {context: ctx} = createPluginContext({
      entry: widgetEntry({
        routes: {e1: {transport: 'http', method: 'GET', path: 'run'}},
      }),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
    });

    expect(ctx.backend).toBeDefined();
    expect(typeof ctx.backend?.fetch).toBe('function');
    expect(typeof ctx.backend?.socket).toBe('function');
    expect(typeof ctx.backend?.status).toBe('function');
  });

  it('wires a backend client when only WebSocket routes are declared', () => {
    const {context: ctx} = createPluginContext({
      entry: widgetEntry({
        routes: {w1: {transport: 'websocket', path: 'stream'}},
      }),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
    });

    expect(ctx.backend).toBeDefined();
  });

  it('forwards setTileTitle when provided', () => {
    const setTileTitle = vi.fn();
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo,
      setTileTitle});

    expect(ctx.setTileTitle).toBe(setTileTitle);
  });

  it('leaves setTileTitle undefined when not provided', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(ctx.setTileTitle).toBeUndefined();
  });

  it('forwards pageRoute to page plugins and omits it for widgets', () => {
    const pageRoute = {childPath$: of(''), navigate: vi.fn(() => Promise.resolve(undefined))};

    const {context: pageContext} = createPluginContext({entry: pageEntry(), instanceId: 'demo:1', hostInfo, deviceInfo,
      pageRoute});
    const {context: widgetContext} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo,
      deviceInfo, pageRoute});

    expect(pageContext.pageRoute).toBe(pageRoute);
    expect(pageContext.kind).toBe('page');
    expect(widgetContext.pageRoute).toBeUndefined();
    expect(widgetContext.kind).toBe('widget');
  });

  it('rejects page contexts without a host-created route', () => {
    expect(() => createPluginContext({entry: pageEntry(), instanceId: 'demo:1', hostInfo, deviceInfo})).toThrow(
      'Page plugin "demo" requires a page route',
    );
  });
});

describe('createPluginContext service boundaries', () => {
  it('uses injected locale and palette services for plugin-facing context reads', () => {
    const localeSpy = vi.fn(() => 'ru');
    const paletteSpy = vi.fn(() => MNDW_TOKENS);
    const injectedLocale = {...localeService, getLocale: localeSpy};
    const injectedPalette = {...paletteService, getTokens: paletteSpy};
    const {context: ctx} = createPluginContext({
      entry: widgetEntry(),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
      services: {locale: injectedLocale, palette: injectedPalette},
    });

    expect(ctx.hostInfo.locale).toBe('ru');
    expect(ctx.getTokens()).toBe(MNDW_TOKENS);
    expect(localeSpy).toHaveBeenCalled();
    expect(paletteSpy).toHaveBeenCalled();
  });

  it('hands out a facade, not the shared rciManager singleton', async () => {
    const {rciService} = await import('../services/rci.service.js');
    const driver = rciService.driver as unknown as Record<string, unknown>;
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const facade = ctx.rciManager as unknown as Record<string, unknown>;

    expect(ctx.rciManager).not.toBe(driver);
    expect(facade.execute).toBeInstanceOf(Function);
  });

  it('forwards facade calls to the shared rciManager and returns its result', async () => {
    const {rciService} = await import('../services/rci.service.js');
    const driver = rciService.driver as unknown as Record<string, unknown>;
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    const result = ctx.rciManager.execute({path: 'x'});

    const execute = driver.execute as ReturnType<typeof vi.fn>;

    expect(execute).toHaveBeenCalledWith({path: 'x'});
    expect(result).toBe('exec-result');
  });
});

describe('palette access', () => {
  it('exposes the applied palette and notifies on change', async () => {
    const service = await import('../services/palette.service.js');
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(ctx.getTokens()).toEqual(service.getTokens());

    const seen: PaletteTokenMap[] = [];
    const unsubscribe = ctx.onPaletteChange((tokens) => seen.push(tokens));
    const next = JSON.parse(JSON.stringify(MNDW_TOKENS)) as PaletteTokenMap;

    next.dark.accent = '#ff0000';
    service.previewOverride(next);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(next);
    expect(ctx.getTokens()).toEqual(MNDW_TOKENS);

    unsubscribe();
    service.discardPreview();
    expect(seen).toHaveLength(1);
  });
});

describe('createPluginContext security boundaries', () => {
  it('does not expose host session lifecycle to plugins', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect('sessionManager' in ctx).toBe(false);
  });

  it('does not expose a service injector to plugins', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect('injector' in ctx).toBe(false);
  });

  it('freezes the context and every security-boundary object on it', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.rciManager)).toBe(true);
    expect(Object.isFrozen(ctx.hostInfo)).toBe(true);
  });

  it('gives every security-boundary object a null prototype', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(Object.getPrototypeOf(ctx)).toBeNull();
    expect(Object.getPrototypeOf(ctx.rciManager)).toBeNull();
    expect(Object.getPrototypeOf(ctx.hostInfo)).toBeNull();
  });

  it('gives separate instances their own facade objects', () => {
    const {context: a} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const {context: b} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo, deviceInfo});

    expect(a.rciManager).not.toBe(b.rciManager);
  });
});

describe('createPluginContext ownership', () => {
  it('returns the overlay dispose alongside the context', async () => {
    const {createPluginOverlayService} = await import('../services/overlay/overlay-manager.svelte.js');
    const disposeSpy = vi.fn();

    vi.mocked(createPluginOverlayService).mockReturnValueOnce({
      service: {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as never,
      dispose: disposeSpy,
    });

    const handle = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(handle.dispose).toBe(disposeSpy);
  });

  it('gives each context an independent disposer for a shared instanceId', () => {
    const first = createPluginContext({entry: widgetEntry(), instanceId: 'dup:1', hostInfo, deviceInfo});
    const second = createPluginContext({entry: widgetEntry(), instanceId: 'dup:1', hostInfo, deviceInfo});

    expect(first.dispose).not.toBe(second.dispose);

    first.dispose('plugin-unmount');
    second.dispose('plugin-unmount');

    expect(first.dispose).toBeTypeOf('function');
    expect(second.dispose).toBeTypeOf('function');
  });

  it('exposes no global disposer side channel', async () => {
    const mod = await import('./plugin-context.js');

    expect((mod as Record<string, unknown>).consumeOverlayDispose).toBeUndefined();
  });
});
