import type {OverlayService} from '@mndw/sdk';
import {type MgmtClient, createMgmtClient, mgmtClient} from './services/mgmt-client.js';
import {type PaletteService, createPaletteService, paletteService} from './services/palette.service.js';
import {
  type PluginCatalogService,
  createPluginCatalogService,
  pluginCatalogService,
} from './services/plugin-catalog.service.js';
import {type LocaleService, createLocaleService, localeService} from './services/locale.service.js';
import {type PluginRegistry, createPluginRegistry, pluginRegistry} from './runtime/plugin-registry.js';
import {
  type PersistentRciSessionService,
  createPersistentRciSessionService,
  persistentRciSessionService,
} from './services/persistent-rci-session.service.js';
import {type RciService, rciService} from './services/rci.service.js';
import {uiOverlayService} from './services/overlay/ui-overlay.js';
import {type TelemetryService, createTelemetryService, telemetryService} from './services/telemetry.service.js';
import {type EventStreamService, createEventStreamService} from './services/event-stream.service.js';

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
  persistentRci: PersistentRciSessionService;
  rci: RciService;
  telemetry: TelemetryService;
  eventStream: EventStreamService;
  overlay: OverlayService;
}

let applicationServices: HostServices | undefined;

export function appHostServices(): HostServices {
  if (applicationServices === undefined) {
    applicationServices = Object.freeze({
      mgmtClient,
      palette: paletteService,
      catalog: pluginCatalogService,
      locale: localeService,
      registry: pluginRegistry,
      persistentRci: persistentRciSessionService,
      rci: rciService,
      telemetry: telemetryService,
      eventStream: createEventStreamService(),
      overlay: uiOverlayService,
    });
  }

  return applicationServices;
}

export function createHostServices(env: HostEnv = {}): HostServices {
  const isolatedMgmtClient = createMgmtClient(env.fetch ?? globalThis.fetch);
  const catalog = createPluginCatalogService({now: env.now});
  const palette = createPaletteService({mgmtClient: isolatedMgmtClient, document: env.document});
  const locale = createLocaleService({
    catalog,
    storage: env.storage,
    document: env.document,
    setUiLocale: env.setUiLocale,
  });
  const registry = createPluginRegistry({catalog});

  return Object.freeze({
    mgmtClient: isolatedMgmtClient,
    palette,
    catalog,
    locale,
    registry,
    persistentRci: createPersistentRciSessionService(),
    rci: rciService,
    telemetry: createTelemetryService(env.fetch ?? globalThis.fetch),
    eventStream: createEventStreamService(),
    overlay: uiOverlayService,
  });
}
