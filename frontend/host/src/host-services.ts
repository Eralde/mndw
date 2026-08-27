import type {OverlayService} from '@mndw/sdk';
import {type MgmtClient, createMgmtClient, mgmtClient as defaultMgmtClient} from './services/mgmt-client.js';
import {
  type PaletteService,
  createPaletteService,
  paletteService as defaultPaletteService,
} from './services/palette.service.js';
import {
  type PluginCatalogService,
  createPluginCatalogService,
  pluginCatalogService as defaultCatalogService,
} from './services/plugin-catalog.service.js';
import {
  type LocaleService,
  createLocaleService,
  localeService as defaultLocaleService,
} from './services/locale.service.js';
import {
  type PluginRegistry,
  createPluginRegistry,
  pluginRegistry as defaultRegistry,
} from './runtime/plugin-registry.js';
import {
  type PersistentRciSessionService,
  createPersistentRciSessionService,
  persistentRciSessionService as defaultPersistentRci,
} from './services/persistent-rci-session.service.js';
import {type RciService, rciService} from './services/rci.service.js';
import {uiOverlayService} from './services/overlay/ui-overlay.js';

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
  overlay: OverlayService;
}

export function createHostServices(env: HostEnv = {}): HostServices {
  const mgmtClient = createMgmtClient(env.fetch ?? globalThis.fetch);
  const catalog = createPluginCatalogService({now: env.now});
  const palette = createPaletteService({mgmtClient, document: env.document});
  const locale = createLocaleService({
    catalog,
    storage: env.storage,
    document: env.document,
    setUiLocale: env.setUiLocale,
  });
  const registry = createPluginRegistry({catalog});

  return Object.freeze({
    mgmtClient,
    palette,
    catalog,
    locale,
    registry,
    persistentRci: createPersistentRciSessionService(),
    rci: rciService,
    overlay: uiOverlayService,
  });
}

const DEFAULT_HOST_SERVICES: HostServices = Object.freeze({
  mgmtClient: defaultMgmtClient,
  palette: defaultPaletteService,
  catalog: defaultCatalogService,
  locale: defaultLocaleService,
  registry: defaultRegistry,
  persistentRci: defaultPersistentRci,
  rci: rciService,
  overlay: uiOverlayService,
});

export function defaultHostServices(): HostServices {
  return DEFAULT_HOST_SERVICES;
}
