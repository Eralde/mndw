import {
  MNDW_TOKENS,
  type OverlayLayer,
  type OverlayService,
  type PageRoute,
  type PluginContext,
  type PluginStorage,
} from '@mndw/sdk';
import {of} from 'rxjs';
import {createTestI18n} from '@mndw/sdk/testing';

export type TestPluginContextOverrides = Partial<PluginContext>;

function createStorage(): PluginStorage {
  const values = new Map<string, string>();

  return {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);

      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);

      return Promise.resolve();
    },
    keys: () => Promise.resolve([...values.keys()]),
  };
}

function createOverlay(): OverlayService {
  const createLayer = <Result>(): OverlayLayer<Result> => {
    const hostElement = document.createElement('div');
    const contentElement = document.createElement('div');

    return {
      hostElement,
      contentElement,
      isOpen: false,
      state: 'closed',
      closed: Promise.resolve({reason: 'api'}),
      signal: new AbortController().signal,
      close: () => {},
      setCleanup: () => {},
      markReady: () => {},
      update: () => {},
      onClose: () => () => {},
    };
  };

  return {
    createLayer: createLayer as OverlayService['createLayer'],
    open: createLayer as OverlayService['open'],
    closeAll: () => {},
  };
}

function createPageRoute(): PageRoute {
  return {
    childPath$: of(''),
    navigate: () => Promise.resolve(),
  };
}

export function createTestPluginContext(overrides: TestPluginContextOverrides = {}): PluginContext {
  const themeListeners = new Set<Parameters<PluginContext['onThemeChange']>[0]>();
  const paletteListeners = new Set<Parameters<PluginContext['onPaletteChange']>[0]>();
  const context: PluginContext = {
    rciManager: {
      execute: () => Promise.resolve(undefined),
      queue: () => Promise.resolve(undefined),
      initBackgroundProcess: () => Promise.resolve(undefined),
      queueBackgroundProcess: () => Promise.resolve(undefined),
    } as unknown as PluginContext['rciManager'],
    storage: createStorage(),
    sharedStorage: createStorage(),
    hostInfo: Object.freeze({
      deviceName: 'Test Device',
      vendor: 'Test Vendor',
      firmwareVersion: '0.0.0-test',
      locale: 'en',
      theme: 'dark',
    }),
    i18n: createTestI18n({}, 'en'),
    injector: {
      get: () => undefined,
      has: () => false,
    },
    instanceId: 'test:1',
    backend: undefined,
    onThemeChange: (callback) => {
      themeListeners.add(callback);

      return () => themeListeners.delete(callback);
    },
    getTokens: () => MNDW_TOKENS,
    onPaletteChange: (callback) => {
      paletteListeners.add(callback);

      return () => paletteListeners.delete(callback);
    },
    overlay: createOverlay(),
    pageRoute: createPageRoute(),
    setTileTitle: () => {},
  };

  return Object.freeze({...context, ...overrides});
}
