import type {OverlayService} from '@mndw/sdk';
import {type MgmtClient, createMgmtClient} from './services/mgmt-client.js';
import {type PaletteService, createPaletteService} from './services/palette.service.js';
import {type PluginCatalogService, createPluginCatalogService} from './services/plugin-catalog.service.js';
import {type LocaleService, createLocaleService} from './services/locale.service.svelte.js';
import {type OpkgClient, createOpkgClient} from './services/opkg-client.js';
import {type ServiceClient, createServiceClient} from './services/service-client.js';
import {type SelfUpdateClient, createSelfUpdateClient} from './services/self-update-client.js';
import {type PluginRegistry, createPluginRegistry} from './runtime/plugin-registry.js';
import {
  type PersistentRciSessionService,
  createPersistentRciSessionService,
} from './services/persistent-rci-session.service.js';
import {type RciService, createRciService} from './services/rci.service.js';
import {type TelemetryService, createTelemetryService} from './services/telemetry.service.js';
import {type EventStreamService, createEventStreamService} from './services/event-stream.service.js';
import {
  type TelemetryGatheringService,
  createTelemetryGatheringService,
} from './services/telemetry-gathering.service.js';
import {type ThemeService, createThemeService} from './services/theme.service.js';
import {type TickerPool, createTickerPool} from './runtime/ticker-pool.js';
import {PluginStylesheets} from './runtime/plugin-stylesheets.js';
import {
  type OverlayRuntime,
  createOverlayRuntime,
  createPluginOverlayService,
} from './services/overlay/overlay-manager.svelte.js';
import {createUiOverlayService} from './services/overlay/ui-overlay.js';
import {type AppRouterService, createAppRouterService} from './router/create-app-router.js';

export interface HostEnv {
  fetch?: typeof globalThis.fetch;
  document?: Document;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  setUiLocale?: (locale: string) => void;
  now?: () => number;
}

export interface HostServices {
  mgmtClient: MgmtClient;
  palette: PaletteService;
  catalog: PluginCatalogService;
  locale: LocaleService;
  registry: PluginRegistry;
  router: AppRouterService;
  opkgClient: OpkgClient;
  serviceClient: ServiceClient;
  selfUpdateClient: SelfUpdateClient;
  persistentRci: PersistentRciSessionService;
  rci: RciService;
  telemetry: TelemetryService;
  telemetryGathering: TelemetryGatheringService;
  eventStream: EventStreamService;
  theme: ThemeService;
  tickerPool: TickerPool;
  pluginStylesheets: PluginStylesheets;
  overlayRuntime: OverlayRuntime;
  overlay: OverlayService;
  hostOverlay: OverlayService;
}

export function createHostServices(env: HostEnv = {}): HostServices {
  const fetchImpl = env.fetch ?? globalThis.fetch;
  const mgmtClient = createMgmtClient(fetchImpl);
  const catalog = createPluginCatalogService({now: env.now});
  const palette = createPaletteService({mgmtClient, document: env.document});
  const locale = createLocaleService({
    catalog,
    storage: env.storage,
    document: env.document,
    setUiLocale: env.setUiLocale,
  });
  const registry = createPluginRegistry({catalog});
  const eventStream = createEventStreamService();
  const overlayRuntime = createOverlayRuntime();
  const uiOverlay = createUiOverlayService(overlayRuntime);
  const hostOverlay = createPluginOverlayService('@host', '@host', overlayRuntime).service;

  return Object.freeze({
    mgmtClient,
    palette,
    catalog,
    locale,
    registry,
    router: createAppRouterService(),
    opkgClient: createOpkgClient(fetchImpl),
    serviceClient: createServiceClient(fetchImpl),
    selfUpdateClient: createSelfUpdateClient(fetchImpl),
    persistentRci: createPersistentRciSessionService(),
    rci: createRciService(),
    telemetry: createTelemetryService(fetchImpl),
    telemetryGathering: createTelemetryGatheringService({
      getTelemetry: () => mgmtClient.getTelemetry(),
      eventStream,
    }),
    eventStream,
    theme: createThemeService({storage: env.storage, document: env.document}),
    tickerPool: createTickerPool(),
    pluginStylesheets: new PluginStylesheets(),
    overlayRuntime,
    overlay: uiOverlay,
    hostOverlay,
  });
}
