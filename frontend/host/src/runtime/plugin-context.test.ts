// @vitest-environment happy-dom
import {
  MNDW_TOKENS,
  PageRouteError,
  type PaletteTokenMap,
  type TelemetryClient,
  type TelemetryGathering,
} from '@mndw/sdk';
import {PLUGIN_RCI_MANAGER_METHODS} from '@mndw/sdk-internal';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, expectTypeOf, it, vi} from 'vitest';
import {
  type CreatePluginContextOptions,
  type PluginContextServices,
  createPluginContext as createPluginContextImpl,
} from './plugin-context.js';
import type {PluginNavigationRouter} from './plugin-navigation.js';
import {createPluginCatalogService} from '../services/plugin-catalog.service.js';
import {toast} from '../services/toast/toast.svelte.js';
import {createHostServices} from '../host-services.js';
import type {PageListEntry, PluginBackendDescriptor, WidgetListEntry} from './plugin-types.js';

vi.mock('../services/rci.service.js', () => ({
  createRciService: () => ({
    driver: {
      execute: vi.fn(() => 'exec-result'),
      queue: vi.fn(),
      initBackgroundProcess: vi.fn(),
      queueBackgroundProcess: vi.fn(),
    },
  }),
}));
vi.mock('../services/storage.service.js', () => ({
  ScopedPluginStorage: class {
    constructor(_prefix: string) {}
  },
}));

vi.mock('../services/overlay/overlay-manager.svelte.js', () => ({
  createOverlayRuntime: vi.fn(() => ({})),
  createPluginOverlayService: vi.fn(() => ({
    service: {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()},
    dispose: vi.fn(),
  })),
}));

const hostInfo = {locale: 'en', theme: 'dark'} as const;
const hostServices = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
const pluginPageRoutes = new Map([['mws-page', '/mws'], ['demo', '/demo']]);
const routerNavigate = vi.fn((_pathname: string): Promise<void> => Promise.resolve());
let gatheringValue: TelemetryGathering | null = null;
const gatheringListeners = new Set<() => void>();
const pluginContextServices: PluginContextServices = {
  ...hostServices,
  locale: hostServices.locale,
  palette: hostServices.palette,
  telemetry: hostServices.telemetry,
  telemetryGathering: {
    get: () => gatheringValue,
    subscribe: (listener) => {
      gatheringListeners.add(listener);

      return () => gatheringListeners.delete(listener);
    },
    report: (enabled) => {
      gatheringValue = {enabled};

      for (const listener of gatheringListeners) {
        listener();
      }
    },
  },
  eventStream: hostServices.eventStream,
  navigation: () => ({
    pageTable: {
      baseRouteOf: (pluginName: string): string | undefined => pluginPageRoutes.get(pluginName),
      pluginNameOf: (baseRoute: string): string | undefined =>
        [...pluginPageRoutes].find(([, route]) => route === baseRoute)?.[0],
    },
    navigate: routerNavigate,
  }),
};

type TestPluginContextOptions = Omit<CreatePluginContextOptions, 'services'> & {
  services?: Partial<PluginContextServices>;
};
type IsRequired<T, K extends keyof T> = T extends Required<Pick<T, K>> ? true : false;

function createPluginContext(options: TestPluginContextOptions): ReturnType<typeof createPluginContextImpl> {
  return createPluginContextImpl({
    ...options,
    services: {...pluginContextServices, ...options.services},
  });
}

class ContextTickerWorker {
  public static readonly instances: ContextTickerWorker[] = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public readonly messages: unknown[] = [];
  public terminated = false;

  constructor() {
    ContextTickerWorker.instances.push(this);
  }

  public postMessage(message: unknown): void {
    this.messages.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  hostServices.theme.setTheme('dark');
  ContextTickerWorker.instances.length = 0;
  gatheringValue = null;
  gatheringListeners.clear();
});

afterEach(() => {
  toast.clear();
  toast.setMaxToasts(4);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it('provides a rejecting backend client when the plugin declares no backend', async () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const pending = ctx.backend.fetch('stats');

    await expect(pending).rejects.toMatchObject({
      name: 'BackendError',
      code: 'BACKEND_NOT_DECLARED',
      message: expect.stringContaining('manifest backend field'),
    });
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
    expect(typeof ctx.backend.fetch).toBe('function');
    expect(typeof ctx.backend.socket).toBe('function');
    expect(typeof ctx.backend.status).toBe('function');
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

  it('provides a widget title setter even when the host callback is omitted', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(ctx.kind).toBe('widget');
    expect(typeof ctx.setTileTitle).toBe('function');
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

  it('wires host navigation for this plugin and disables navigation after disposal', () => {
    const handle = createPluginContext({entry: pageEntry(), instanceId: 'demo:1', hostInfo, deviceInfo,
      pageRoute: {childPath$: of(''), navigate: vi.fn(() => Promise.resolve())}});

    expect(handle.context.navigation.href({kind: 'plugin-page', plugin: 'demo'})).toBe('/demo');
    expect(handle.context.navigation.navigate({kind: 'settings', tab: 'general'})).toBe(true);
    expect(routerNavigate).toHaveBeenCalledWith('/settings/general');

    handle.dispose();

    expect(handle.context.navigation.navigate({kind: 'dashboard'})).toBe(false);
    expect(routerNavigate).toHaveBeenCalledTimes(1);
  });

  it('resolves the navigation router lazily when it becomes ready', () => {
    const routerState: {router?: PluginNavigationRouter} = {};
    const navigationProvider = vi.fn(() => routerState.router);
    const handle = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo,
      services: {navigation: navigationProvider}});

    expect(navigationProvider).not.toHaveBeenCalled();
    expect(handle.context.navigation.href({kind: 'plugin-page', plugin: 'demo'})).toBeUndefined();
    expect(navigationProvider).toHaveBeenCalledTimes(1);

    const previousNavigateCalls = routerNavigate.mock.calls.length;

    expect(handle.context.navigation.navigate({kind: 'dashboard'})).toBe(false);
    expect(routerNavigate).toHaveBeenCalledTimes(previousNavigateCalls);

    routerState.router = {
      pageTable: {
        baseRouteOf: (pluginName: string): string | undefined => pluginPageRoutes.get(pluginName),
        pluginNameOf: (baseRoute: string): string | undefined =>
          [...pluginPageRoutes].find(([, route]) => route === baseRoute)?.[0],
      },
      navigate: routerNavigate,
    };

    expect(handle.context.navigation.href({kind: 'plugin-page', plugin: 'demo'})).toBe('/demo');
    expect(navigationProvider).toHaveBeenCalledTimes(3);
  });

  it('rejects page contexts without a host-created route', () => {
    expect(() => createPluginContext({entry: pageEntry(), instanceId: 'demo:1', hostInfo, deviceInfo})).toThrow(
      'Page plugin "demo" requires a page route',
    );
  });
});

describe('createPluginContext service boundaries', () => {
  it('requires host services', () => {
    expectTypeOf<IsRequired<Parameters<typeof createPluginContextImpl>[0], 'services'>>().toEqualTypeOf<true>();
  });

  it('reads live theme, locale and palette through getters', () => {
    let locale = 'en';
    let palette: PaletteTokenMap = MNDW_TOKENS;
    const localeListeners = new Set<(value: string) => void>();
    const paletteListeners = new Set<(value: PaletteTokenMap) => void>();
    const injectedLocale = {
      ...hostServices.locale,
      getLocale: () => locale,
      subscribeLocale: (callback: (value: string) => void): () => void => {
        localeListeners.add(callback);

        return () => localeListeners.delete(callback);
      },
    };
    const injectedPalette = {
      ...hostServices.palette,
      getTokens: () => palette,
      subscribePalette: (callback: (value: PaletteTokenMap) => void): () => void => {
        paletteListeners.add(callback);

        return () => paletteListeners.delete(callback);
      },
    };
    const {context: ctx} = createPluginContext({
      entry: widgetEntry(),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
      services: {locale: injectedLocale, palette: injectedPalette},
    });

    const subscriptions = [
      ctx.appearance.theme$.subscribe(),
      ctx.i18n.locale$.subscribe(),
      ctx.appearance.palette$.subscribe(),
    ];

    hostServices.theme.setTheme('light');

    locale = 'ru';

    for (const listener of localeListeners) {
      listener(locale);
    }

    const nextPalette = {...MNDW_TOKENS, dark: {...MNDW_TOKENS.dark, accent: '#ff0000'}};

    palette = nextPalette;

    for (const listener of paletteListeners) {
      listener(palette);
    }

    expect(ctx.appearance.theme).toBe('light');
    expect(ctx.i18n.locale).toBe('ru');
    expect(ctx.appearance.palette).toBe(nextPalette);
    expect(typeof ctx.telemetry.fetchProjected).toBe('function');
    expect(ctx.telemetry.gathering$).toBeDefined();

    subscriptions.forEach((subscription) => subscription.unsubscribe());
  });

  it('completes theme$ on dispose', () => {
    const handle = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    let completeCount = 0;

    handle.context.appearance.theme$.subscribe({complete: () => completeCount += 1});
    handle.dispose('plugin-unmount');

    expect(completeCount).toBe(1);
  });

  it('emits known gathering state changes and completes on dispose', () => {
    const {context, dispose} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const values: TelemetryGathering[] = [];
    let completeCount = 0;

    context.telemetry.gathering$.subscribe({
      next: (value) => values.push(value),
      complete: () => completeCount += 1,
    });

    expect(values).toEqual([]);
    pluginContextServices.telemetryGathering.report(true);
    pluginContextServices.telemetryGathering.report(false);

    expect(values).toEqual([{enabled: true}, {enabled: false}]);

    dispose('plugin-unmount');

    expect(completeCount).toBe(1);
  });

  it('emits the latest known gathering state immediately to each context', () => {
    pluginContextServices.telemetryGathering.report(true);

    const first = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const second = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo, deviceInfo});
    const firstValues: TelemetryGathering[] = [];
    const secondValues: TelemetryGathering[] = [];

    first.context.telemetry.gathering$.subscribe((value) => firstValues.push(value));
    second.context.telemetry.gathering$.subscribe((value) => secondValues.push(value));

    expect(firstValues).toEqual([{enabled: true}]);
    expect(secondValues).toEqual([{enabled: true}]);

    pluginContextServices.telemetryGathering.report(false);

    expect(firstValues).toEqual([{enabled: true}, {enabled: false}]);
    expect(secondValues).toEqual([{enabled: true}, {enabled: false}]);

    first.dispose('plugin-unmount');
    second.dispose('plugin-unmount');
  });

  it('delegates projected telemetry fetches through the per-context telemetry object', async () => {
    const snapshot = {} as Awaited<ReturnType<TelemetryClient['fetchProjected']>>;
    const fetchProjected = vi.fn<TelemetryClient['fetchProjected']>().mockResolvedValue(snapshot);
    const {context} = createPluginContext({
      entry: widgetEntry(),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
      services: {telemetry: {fetchProjected}},
    });

    await expect(context.telemetry.fetchProjected('1h')).resolves.toBe(snapshot);
    expect(fetchProjected).toHaveBeenCalledWith('1h');
  });

  it('has no callback members', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect('onThemeChange' in ctx).toBe(false);
    expect('onPaletteChange' in ctx).toBe(false);
    expect('getTokens' in ctx).toBe(false);
    expect('hostInfo' in ctx).toBe(false);
  });

  it('hands out Observables, never Subjects', () => {
    const pageRoute = {childPath$: of(''), navigate: vi.fn(() => Promise.resolve(undefined))};
    const {context: ctx} = createPluginContext({
      entry: pageEntry(),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
      pageRoute,
    });

    expect('next' in ctx.appearance.theme$).toBe(false);
    expect('next' in ctx.i18n.locale$).toBe(false);
    expect('next' in ctx.appearance.palette$).toBe(false);
    expect('next' in (ctx.kind === 'page' ? ctx.pageRoute.childPath$ : of(''))).toBe(false);
  });

  it('uses injected locale and palette services for plugin-facing getters', () => {
    const localeSpy = vi.fn(() => 'ru');
    const paletteSpy = vi.fn(() => MNDW_TOKENS);
    const injectedLocale = {...hostServices.locale, getLocale: localeSpy};
    const injectedPalette = {...hostServices.palette, getTokens: paletteSpy};
    const {context: ctx} = createPluginContext({
      entry: widgetEntry(),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
      services: {locale: injectedLocale, palette: injectedPalette},
    });

    expect(ctx.i18n.locale).toBe('ru');
    expect(ctx.appearance.palette).toBe(MNDW_TOKENS);
    expect(localeSpy).toHaveBeenCalled();
    expect(paletteSpy).toHaveBeenCalled();
  });

  it('hands out a facade, not the shared rciManager singleton', () => {
    const driver = hostServices.rci.driver as unknown as Record<string, unknown>;
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const facade = ctx.device.rci as unknown as Record<string, unknown>;

    expect(ctx.device.rci).not.toBe(driver);
    expect(facade.execute).toBeInstanceOf(Function);
  });

  it('forwards facade calls to the shared rciManager and returns its result', () => {
    const driver = hostServices.rci.driver as unknown as Record<string, unknown>;
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    const result = ctx.device.rci.execute({path: 'x'});

    const execute = driver.execute as ReturnType<typeof vi.fn>;

    expect(execute).toHaveBeenCalledWith({path: 'x'});
    expect(result).toBe('exec-result');
  });
});

describe('plugin RCI facade', () => {
  it('exposes exactly the plugin RCI methods', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(Object.keys(ctx.device.rci).sort()).toEqual([...PLUGIN_RCI_MANAGER_METHODS, 'query'].sort());
    expect('destroy' in ctx.device.rci).toBe(false);
    expect('replaceBatchScheduler' in ctx.device.rci).toBe(false);
    expect('toggleStats' in ctx.device.rci).toBe(false);
    expect('stats$' in ctx.device.rci).toBe(false);
    expect(Object.isFrozen(ctx.device.rci)).toBe(true);
  });

  it('implements query through the shared manager queue', async () => {
    const driver = hostServices.rci.driver as unknown as {queue: ReturnType<typeof vi.fn>};
    const response = {version: '1'};

    driver.queue.mockReturnValueOnce(of(response));

    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    await expect(ctx.device.rci.query({path: 'show.version'})).resolves.toBe(response);

    expect(driver.queue).toHaveBeenCalledWith({path: 'show.version'}, undefined);
  });
});

describe('palette access', () => {
  it('exposes the applied palette and notifies on change', () => {
    const service = hostServices.palette;
    const handle = createPluginContext({
      entry: widgetEntry(),
      instanceId: 'demo:1',
      hostInfo,
      deviceInfo,
      services: {palette: service},
    });
    const {context: ctx} = handle;

    expect(ctx.appearance.palette).toEqual(service.getTokens());

    const seen: PaletteTokenMap[] = [];
    const subscription = ctx.appearance.palette$.subscribe((tokens) => seen.push(tokens));
    const next = JSON.parse(JSON.stringify(MNDW_TOKENS)) as PaletteTokenMap;

    next.dark.accent = '#ff0000';
    service.previewOverride(next);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(MNDW_TOKENS);
    expect(seen[1]).toEqual(next);
    expect(ctx.appearance.palette).toEqual(MNDW_TOKENS);

    subscription.unsubscribe();
    service.discardPreview();
    expect(seen).toHaveLength(2);
    handle.dispose('plugin-unmount');
  });
});

describe('createPluginContext security boundaries', () => {
  it('freezes grouped context objects and omits replaced top-level members', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(Object.getPrototypeOf(ctx)).toBeNull();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.storage)).toBe(true);
    expect(Object.isFrozen(ctx.appearance)).toBe(true);
    expect(Object.isFrozen(ctx.device)).toBe(true);
    expect(Object.isFrozen(ctx.timers)).toBe(true);
    expect('sharedStorage' in ctx).toBe(false);
    expect('deviceInfo' in ctx).toBe(false);
    expect('rciManager' in ctx).toBe(false);
    expect('createTicker' in ctx).toBe(false);
    expect('theme' in ctx).toBe(false);
    expect('palette' in ctx).toBe(false);
    expect('locale' in ctx).toBe(false);
  });

  it('does not expose host session lifecycle or legacy context members to plugins', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect('sessionManager' in ctx).toBe(false);
    expect('onThemeChange' in ctx).toBe(false);
    expect('onPaletteChange' in ctx).toBe(false);
    expect('getTokens' in ctx).toBe(false);
    expect('hostInfo' in ctx).toBe(false);
  });

  it('does not expose a service injector to plugins', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect('injector' in ctx).toBe(false);
  });

  it('freezes the context and every security-boundary object on it', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.storage)).toBe(true);
    expect(Object.isFrozen(ctx.appearance)).toBe(true);
    expect(Object.isFrozen(ctx.device)).toBe(true);
    expect(Object.isFrozen(ctx.timers)).toBe(true);
    expect(Object.isFrozen(ctx.device.rci)).toBe(true);
  });

  it('gives every security-boundary object a null prototype', () => {
    const {context: ctx} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    expect(Object.getPrototypeOf(ctx)).toBeNull();
    expect(Object.getPrototypeOf(ctx.storage)).toBeNull();
    expect(Object.getPrototypeOf(ctx.appearance)).toBeNull();
    expect(Object.getPrototypeOf(ctx.device)).toBeNull();
    expect(Object.getPrototypeOf(ctx.timers)).toBeNull();
    expect(Object.getPrototypeOf(ctx.device.rci)).toBeNull();
  });

  it('gives separate instances their own facade objects', () => {
    const {context: a} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const {context: b} = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo, deviceInfo});

    expect(a.device.rci).not.toBe(b.device.rci);
  });
});

describe('createPluginContext ownership', () => {
  it('aborts the context signal on disposal with an AbortError reason', () => {
    const handle = createPluginContext({entry: widgetEntry(), instanceId: 'signal:1', hostInfo, deviceInfo});

    expect(handle.context.signal).toBeInstanceOf(AbortSignal);
    expect(handle.context.signal.aborted).toBe(false);

    handle.dispose('host-navigation');

    expect(handle.context.signal.aborted).toBe(true);
    expect(handle.context.signal.reason).toBeInstanceOf(DOMException);
    expect(handle.context.signal.reason).toMatchObject({name: 'AbortError'});
  });

  it('creates a ticker that is destroyed with the plugin lifetime', () => {
    vi.stubGlobal('Worker', ContextTickerWorker);

    try {
      const handle = createPluginContext({entry: widgetEntry(), instanceId: 'ticker:1', hostInfo, deviceInfo});
      const ticker = handle.context.timers.createTicker();
      const complete = vi.fn();

      ticker.tick$.subscribe({complete});
      ticker.start(1000);
      handle.dispose('plugin-unmount');

      expect(complete).toHaveBeenCalledOnce();
      expect(ContextTickerWorker.instances[0]?.messages).toEqual([
        expect.objectContaining({command: 'start', interval: 1000}),
        expect.objectContaining({command: 'stop'}),
      ]);
      expect(ContextTickerWorker.instances[0]?.terminated).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns a disposer that ends the context and disposes the overlay', async () => {
    const {createPluginOverlayService} = await import('../services/overlay/overlay-manager.svelte.js');
    const disposeSpy = vi.fn();

    vi.mocked(createPluginOverlayService).mockReturnValueOnce({
      service: {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as never,
      dispose: disposeSpy,
    });

    const handle = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});

    handle.dispose('plugin-unmount');

    expect(disposeSpy).toHaveBeenCalledWith('plugin-unmount');
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

describe('plugin toast facade', () => {
  it('labels plugin toasts and keeps same-key toasts isolated from other instances and the host', () => {
    const first = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const second = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo, deviceInfo});

    first.context.toast.show({message: 'first', key: 'shared', duration: 0});
    second.context.toast.show({message: 'second', key: 'shared', duration: 0});
    toast.show({message: 'host', key: 'shared', duration: 0});

    expect(toast.toasts.map(({message, pluginLabel}) => ({message, pluginLabel}))).toEqual([
      {message: 'first', pluginLabel: 'Demo'},
      {message: 'second', pluginLabel: 'Demo'},
      {message: 'host', pluginLabel: undefined},
    ]);

    first.dispose('plugin-unmount');
    second.dispose('plugin-unmount');
  });

  it('replaces a keyed toast only within the same plugin instance', () => {
    const first = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const second = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo, deviceInfo});

    first.context.toast.show({message: 'old first', key: 'shared', duration: 0});
    second.context.toast.show({message: 'second', key: 'shared', duration: 0});

    const priorId = toast.toasts.find(({message}) => message === 'old first')?.id;

    first.context.toast.info('new first', {key: 'shared', duration: 0});

    expect(toast.toasts).toHaveLength(2);
    expect(toast.toasts.find(({message}) => message === 'new first')?.id).toBe(priorId);
    expect(toast.toasts.some(({message}) => message === 'second')).toBe(true);

    first.dispose('plugin-unmount');
    second.dispose('plugin-unmount');
  });

  it('warns per instance again only after its rate-limit window drains', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    toast.setMaxToasts(50);

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = createPluginContext({entry: widgetEntry(), instanceId: 'demo:limit:first', hostInfo, deviceInfo});
    const second = createPluginContext({entry: widgetEntry(), instanceId: 'demo:limit:second', hostInfo, deviceInfo});

    first.context.toast.show({message: 'keyed', key: 'replace', duration: 0});

    for (let index = 1; index < 8; index += 1) {
      first.context.toast.show({message: `first toast ${index}`, duration: 0});
    }

    first.context.toast.show({message: 'replacement', key: 'replace', duration: 0});

    const firstDrop = first.context.toast.show({message: 'first dropped', duration: 0});

    for (let index = 0; index < 8; index += 1) {
      second.context.toast.show({message: `second toast ${index}`, duration: 0});
    }

    const secondDrop = second.context.toast.show({message: 'second dropped', duration: 0});

    expect(toast.toasts).toHaveLength(16);
    expect(toast.toasts.some(({message}) => message === 'replacement')).toBe(true);
    expect(toast.toasts.some(({message}) => message === 'first dropped' || message === 'second dropped')).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('demo'));

    firstDrop.dismiss();
    secondDrop.dismiss();
    first.context.toast.show({message: 'first still dropped', duration: 0});
    second.context.toast.show({message: 'second still dropped', duration: 0});
    expect(warning).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(9_999);
    first.context.toast.show({message: 'first before reset', duration: 0});
    second.context.toast.show({message: 'second before reset', duration: 0});
    expect(warning).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);

    for (let index = 0; index < 8; index += 1) {
      first.context.toast.show({message: `first reset ${index}`, duration: 0});
      second.context.toast.show({message: `second reset ${index}`, duration: 0});
    }

    first.context.toast.show({message: 'first dropped again', duration: 0});
    second.context.toast.show({message: 'second dropped again', duration: 0});

    expect(warning).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenNthCalledWith(3, expect.stringContaining('demo'));
    expect(warning).toHaveBeenNthCalledWith(4, expect.stringContaining('demo'));
    expect(toast.toasts.some(({message}) => message === 'first dropped again' || message === 'second dropped again'))
      .toBe(false);

    first.dispose('plugin-unmount');
    second.dispose('plugin-unmount');
  });

  it('closes only this instance’s action toasts and warns once after unmount', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = createPluginContext({entry: widgetEntry(), instanceId: 'demo:1', hostInfo, deviceInfo});
    const second = createPluginContext({entry: widgetEntry(), instanceId: 'demo:2', hostInfo, deviceInfo});

    first.context.toast.show({message: 'action first', duration: 0, action: {label: 'Go', onAction: () => {}}});
    first.context.toast.show({message: 'plain first', duration: 0});
    second.context.toast.show({message: 'action second', duration: 0, action: {label: 'Go', onAction: () => {}}});

    first.dispose('plugin-unmount');
    first.context.toast.info('after unmount');
    first.context.toast.dismiss('missing');

    expect(toast.toasts.map(({message}) => message)).toEqual(['plain first', 'action second']);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('demo'));

    second.dispose('plugin-unmount');
  });

  it('contains throwing and rejecting actions and logs the plugin name', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = createPluginContext({entry: widgetEntry(), instanceId: 'demo:actions', hostInfo, deviceInfo});
    const thrown = new Error('sync failure');
    const rejected = new Error('async failure');

    handle.context.toast.error('sync', {
      duration: 0,
      action: {label: 'Retry', onAction: (): void => {
        throw thrown;
      }},
    });
    handle.context.toast.error('async', {
      duration: 0,
      action: {label: 'Retry', onAction: async (): Promise<void> => Promise.reject(rejected)},
    });

    const actions = toast.toasts.map(({action}) => action?.onAction());

    expect(actions[0]).toBeUndefined();
    await expect(actions[1]).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenNthCalledWith(1, expect.stringContaining('demo'), thrown);
    expect(errorLog).toHaveBeenNthCalledWith(2, expect.stringContaining('demo'), rejected);

    handle.dispose('plugin-unmount');
  });
});
