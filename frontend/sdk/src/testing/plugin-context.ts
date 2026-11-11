import {BehaviorSubject, NEVER, ReplaySubject, Subject, filter, of, takeUntil} from 'rxjs';
import type {BackendClient} from '../backend-client.js';
import type {
  DeviceInfo,
  HostNavigation,
  HostTarget,
  PagePluginContext,
  PageRoute,
  PluginContext,
  WidgetPluginContext,
} from '../context.js';
import type {MndwEvent, PluginEventFacade} from '../event-schema.js';
import type {PluginI18n} from '../i18n.js';
import {MNDW_TOKENS, type MndwThemeName} from '../tokens.js';
import type {PaletteTokenMap} from '../palette.js';
import type {PluginRciManager} from '../rci.js';
import type {PluginTelemetry} from '../telemetry-client.js';
import type {OverlayService} from '../overlay.js';
import type {PluginStorage} from '../storage.js';
import type {Ticker, TickerTick} from '../ticker.js';
import {createTestI18n} from './i18n.js';

export interface TestPluginContextOptions {
  kind?: 'widget' | 'page';
  theme?: MndwThemeName;
  locale?: string;
  palette?: PaletteTokenMap;
  i18n?: PluginI18n;
  rciManager?: Partial<PluginRciManager>;
  backend?: BackendClient;
  telemetry?: Partial<PluginTelemetry>;
  pageRoute?: PageRoute;
  instanceId?: string;
  events?: boolean;
}

export interface TestPluginContext<C extends PluginContext = PluginContext> {
  readonly context: C;
  readonly navigationCalls: HostTarget[];
  setTheme(theme: MndwThemeName): void;
  setLocale(locale: string): void;
  setPalette(palette: PaletteTokenMap): void;
  tick(timestamp?: number): void;
  emitEvent(event: MndwEvent): void;
  resync(): void;
  unmount(): void;
}

function eventMatchesTopics(topics: string | readonly string[], topic: string): boolean {
  const filters = (typeof topics === 'string' ? [topics] : [...topics]).flatMap((value) => value.split(','));

  return filters.some((filterValue) => {
    return filterValue === '*' || topic === filterValue || topic.startsWith(`${filterValue}.`);
  });
}

function createStorage(): PluginStorage {
  const values = new Map<string, string>();

  return {
    get: (key): Promise<string | null> => Promise.resolve(values.get(key) ?? null),
    set: (key, value): Promise<void> => {
      values.set(key, value);

      return Promise.resolve();
    },
    delete: (key): Promise<void> => {
      values.delete(key);

      return Promise.resolve();
    },
    keys: (): Promise<string[]> => Promise.resolve([...values.keys()]),
  };
}

function createOverlay(): OverlayService {
  const notConfigured = (method: string): never => {
    throw new Error(`test overlay.${method} not configured`);
  };

  return {
    createLayer: () => notConfigured('createLayer'),
    open: () => notConfigured('open'),
    closeAll: () => notConfigured('closeAll'),
  };
}

function createDeviceInfo(): DeviceInfo {
  return Object.freeze({
    deviceName: '',
    vendor: '',
    manufacturer: '',
    model: '',
    series: '',
    region: '',
    hwId: '',
    hwVersion: '',
    firmwareVersion: '',
    firmwareRelease: '',
    features: [],
    components: [],
    switchports: {list: [], layout: [], hasPortStats: false},
    usb: {ports: []},
    hasFeature: (): boolean => false,
    hasComponent: (): boolean => false,
  });
}

function createRciManager(overrides: Partial<PluginRciManager> | undefined): PluginRciManager {
  const methods: PluginRciManager = {
    execute: () => {
      throw new Error('test rciManager.execute not configured');
    },
    queue: () => {
      throw new Error('test rciManager.queue not configured');
    },
    initBackgroundProcess: () => {
      throw new Error('test rciManager.initBackgroundProcess not configured');
    },
    queueBackgroundProcess: () => {
      throw new Error('test rciManager.queueBackgroundProcess not configured');
    },
  };

  return Object.freeze({...methods, ...overrides});
}

function createTelemetry(ended: ReplaySubject<void>, overrides: Partial<PluginTelemetry> = {}): PluginTelemetry {
  return {
    fetchProjected: () => Promise.reject(new Error('test telemetry.fetchProjected not configured')),
    ...overrides,
    gathering$: (overrides.gathering$ ?? NEVER).pipe(takeUntil(ended.asObservable())),
  };
}

export function createTestPluginContext(
  options?: TestPluginContextOptions & {kind?: 'widget'},
): TestPluginContext<WidgetPluginContext>;
export function createTestPluginContext(
  options: TestPluginContextOptions & {kind: 'page'},
): TestPluginContext<PagePluginContext>;
export function createTestPluginContext(options: TestPluginContextOptions = {}): TestPluginContext<PluginContext> {
  const theme = new BehaviorSubject(options.theme ?? 'light');
  const locale = new BehaviorSubject(options.locale ?? 'en');
  const palette = new BehaviorSubject(options.palette ?? MNDW_TOKENS);
  const ended = new ReplaySubject<void>(1);
  const fixtureI18n = createTestI18n({}, options.locale ?? 'en');
  const eventSubject = new Subject<MndwEvent>();
  const resyncSubject = new Subject<void>();
  const tickers = new Set<{tick(timestamp: number): void; destroy(): void}>();
  const navigationCalls: HostTarget[] = [];
  const abortController = new AbortController();
  let unmounted = false;
  const createTicker = (): Ticker => {
    const subject = new Subject<TickerTick>();
    let running = false;
    let destroyed = unmounted;
    const ticker = {
      start: (_intervalMs: number): void => {
        if (!destroyed) {
          running = true;
        }
      },
      setInterval: (_intervalMs: number): void => {},
      stop: (): void => {
        running = false;
      },
      tick$: subject.asObservable(),
      tick: (timestamp: number): void => {
        if (running && !destroyed) {
          subject.next({timestamp, drift: 0});
        }
      },
      destroy: (): void => {
        if (destroyed) {
          return;
        }

        destroyed = true;
        running = false;
        tickers.delete(ticker);
        subject.complete();
      },
    };

    if (destroyed) {
      subject.complete();
    } else {
      tickers.add(ticker);
    }

    return ticker;
  };
  const events: PluginEventFacade | undefined = options.events === true
    ? {
      select$: (topics) =>
        eventSubject.asObservable().pipe(
          filter((event) => eventMatchesTopics(topics, event.topic)),
          takeUntil(ended.asObservable()),
        ),
      resync$: resyncSubject.asObservable().pipe(takeUntil(ended.asObservable())),
    }
    : undefined;
  const navigation: HostNavigation = {
    href: () => undefined,
    navigate: (target): boolean => {
      navigationCalls.push(target);

      return true;
    },
  };
  const base = Object.assign(Object.create(null) as Record<string, unknown>, {
    signal: abortController.signal,
    navigation,
    telemetry: createTelemetry(ended, options.telemetry),
    rciManager: createRciManager(options.rciManager),
    storage: createStorage(),
    sharedStorage: createStorage(),
    deviceInfo: createDeviceInfo(),
    i18n: options.i18n ?? fixtureI18n,
    instanceId: options.instanceId ?? 'test:1',
    createTicker,
    events,
    backend: options.backend,
    overlay: createOverlay(),
  });

  Object.defineProperties(base, {
    theme: {enumerable: true, get: () => theme.value},
    theme$: {enumerable: true, value: theme.asObservable()},
    locale: {enumerable: true, get: () => locale.value},
    locale$: {enumerable: true, value: locale.asObservable()},
    palette: {enumerable: true, get: () => palette.value},
    palette$: {enumerable: true, value: palette.asObservable()},
  });

  let context: PluginContext;

  if (options.kind === 'page') {
    const route = options.pageRoute ?? {childPath$: of(''), navigate: async (): Promise<void> => {}};

    context = Object.assign(base, {
      kind: 'page' as const,
      pageRoute: {...route, childPath$: route.childPath$.pipe(takeUntil(ended.asObservable()))},
    }) as unknown as PagePluginContext;
  } else {
    context = Object.assign(base, {kind: 'widget' as const}) as unknown as WidgetPluginContext;
  }

  return {
    context: Object.freeze(context),
    navigationCalls,
    setTheme: (next): void => theme.next(next),
    setLocale: (next): void => {
      locale.next(next);

      if (options.i18n === undefined) {
        fixtureI18n.setLocale(next, {});
      }
    },
    setPalette: (next): void => palette.next(next),
    tick: (timestamp = Date.now()): void => {
      for (const ticker of tickers) {
        ticker.tick(timestamp);
      }
    },
    emitEvent: (event): void => eventSubject.next(event),
    resync: (): void => resyncSubject.next(),
    unmount: (): void => {
      if (unmounted) {
        return;
      }

      unmounted = true;
      abortController.abort();

      for (const ticker of [...tickers]) {
        ticker.destroy();
      }

      ended.next();
      ended.complete();
      theme.complete();
      locale.complete();
      palette.complete();
      eventSubject.complete();
      resyncSubject.complete();
    },
  };
}
