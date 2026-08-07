import {MNDW_TOKENS, PageRouteError, type PaletteTokenMap} from '@mndw/sdk';
import {of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {createPluginContext} from './plugin-context.js';
import type {PageListEntry, PluginBackendDescriptor, WidgetListEntry} from './plugin-types.js';

vi.mock('../services/rci.service.js', () => ({
  rciService: {
    driver: {
      execute: vi.fn(() => 'exec-result'),
      queue: vi.fn(),
      initBackgroundProcess: vi.fn(),
      queueBackgroundProcess: vi.fn(),
    },
    auth: {
      isAuthenticated: vi.fn(),
      getRealmHeader: vi.fn(),
      login: vi.fn(() => 'login-result'),
      logout: vi.fn(),
      toggleErrorLogging: vi.fn(),
    },
  },
}));
vi.mock('../services/storage.service.js', () => ({
  ScopedPluginStorage: class {
    constructor(_prefix: string) {}
  },
}));
vi.mock('../services/injector.service.js', () => ({
  injector: {get: vi.fn(() => 'service'), has: vi.fn(() => true), register: vi.fn()},
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

const hostInfo = {deviceName: 'Device', vendor: 'Vendor', firmwareVersion: '1.0', theme: 'dark'} as const;

const emptyBackend: PluginBackendDescriptor = {
  endpoints: {},
  websockets: {},
  opkg: [],
  daemon: false,
  public: false,
};

function widgetEntry(backend: PluginBackendDescriptor = emptyBackend): WidgetListEntry {
  return {
    name: 'demo',
    type: 'widget',
    version: '1.0.0',
    label: 'Demo',
    entry: 'index.js',
    source: 'user',
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
  it('exposes stable page-route errors', () => {
    const error = new PageRouteError('INVALID_PATH', 'invalid child path');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PageRouteError');
    expect(error.code).toBe('INVALID_PATH');
  });

  it('attaches the overlay service', () => {
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    expect(ctx.overlay).toBeDefined();
    expect(typeof ctx.overlay.createLayer).toBe('function');
    expect(typeof ctx.overlay.open).toBe('function');
    expect(typeof ctx.overlay.closeAll).toBe('function');
  });

  it('omits backend when the plugin declares nothing callable', () => {
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    expect(ctx.backend).toBeUndefined();
  });

  it('wires a backend client when endpoints are declared', () => {
    const ctx = createPluginContext(
      widgetEntry({
        endpoints: {e1: {method: 'GET', path: 'run'}},
        websockets: {},
        opkg: [],
        daemon: false,
        public: false,
      }),
      'demo:1',
      hostInfo,
    );

    expect(ctx.backend).toBeDefined();
    expect(typeof ctx.backend?.fetch).toBe('function');
    expect(typeof ctx.backend?.socket).toBe('function');
  });

  it('wires a backend client when only websockets are declared', () => {
    const ctx = createPluginContext(
      widgetEntry({
        endpoints: {},
        websockets: {w1: {path: 'stream'}},
        opkg: [],
        daemon: false,
        public: false,
      }),
      'demo:1',
      hostInfo,
    );

    expect(ctx.backend).toBeDefined();
  });

  it('forwards setTileTitle when provided', () => {
    const setTileTitle = vi.fn();
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo, setTileTitle);

    expect(ctx.setTileTitle).toBe(setTileTitle);
  });

  it('leaves setTileTitle undefined when not provided', () => {
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    expect(ctx.setTileTitle).toBeUndefined();
  });

  it('forwards pageRoute to page plugins and omits it for widgets', () => {
    const pageRoute = {childPath$: of(''), navigate: vi.fn(() => Promise.resolve(undefined))};

    const pageContext = createPluginContext(pageEntry(), 'demo:1', hostInfo, undefined, pageRoute);
    const widgetContext = createPluginContext(widgetEntry(), 'demo:2', hostInfo, undefined, pageRoute);

    expect(pageContext.pageRoute).toBe(pageRoute);
    expect(widgetContext.pageRoute).toBeUndefined();
  });
});

describe('createPluginContext service boundaries', () => {
  it('hands out a facade, not the shared rciManager singleton', async () => {
    const {rciService} = await import('../services/rci.service.js');
    const driver = rciService.driver as unknown as Record<string, unknown>;
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);
    const facade = ctx.rciManager as unknown as Record<string, unknown>;

    expect(ctx.rciManager).not.toBe(driver);
    expect(facade.execute).toBeInstanceOf(Function);
  });

  it('forwards facade calls to the shared rciManager and returns its result', async () => {
    const {rciService} = await import('../services/rci.service.js');
    const driver = rciService.driver as unknown as Record<string, unknown>;
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    const result = ctx.rciManager.execute({path: 'x'});

    const execute = driver.execute as ReturnType<typeof vi.fn>;

    expect(execute).toHaveBeenCalledWith({path: 'x'});
    expect(result).toBe('exec-result');
  });
});

describe('palette access', () => {
  it('exposes the applied palette and notifies on change', async () => {
    const service = await import('../services/palette.service.js');
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

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
  it('hands out a facade, not the shared sessionManager singleton', async () => {
    const {rciService} = await import('../services/rci.service.js');
    const auth = rciService.auth as unknown as Record<string, unknown>;
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);
    const facade = ctx.sessionManager as unknown as Record<string, unknown>;

    expect(ctx.sessionManager).not.toBe(auth);
    expect(facade.isAuthenticated).toBeInstanceOf(Function);
  });

  it('forwards facade calls to the shared sessionManager and returns its result', async () => {
    const {rciService} = await import('../services/rci.service.js');
    const auth = rciService.auth as unknown as Record<string, unknown>;
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    const result = ctx.sessionManager.login('user', 'pass');

    const login = auth.login as ReturnType<typeof vi.fn>;

    expect(login).toHaveBeenCalledWith('user', 'pass');
    expect(result).toBe('login-result');
  });

  it('exposes a read-only injector without register', () => {
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    expect(typeof ctx.injector.get).toBe('function');
    expect((ctx.injector as unknown as Record<string, unknown>).register).toBeUndefined();
  });

  it('freezes the context and every security-boundary object on it', () => {
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.rciManager)).toBe(true);
    expect(Object.isFrozen(ctx.sessionManager)).toBe(true);
    expect(Object.isFrozen(ctx.injector)).toBe(true);
    expect(Object.isFrozen(ctx.hostInfo)).toBe(true);
  });

  it('gives every security-boundary object a null prototype', () => {
    const ctx = createPluginContext(widgetEntry(), 'demo:1', hostInfo);

    expect(Object.getPrototypeOf(ctx)).toBeNull();
    expect(Object.getPrototypeOf(ctx.rciManager)).toBeNull();
    expect(Object.getPrototypeOf(ctx.sessionManager)).toBeNull();
    expect(Object.getPrototypeOf(ctx.injector)).toBeNull();
    expect(Object.getPrototypeOf(ctx.hostInfo)).toBeNull();
  });

  it('gives separate instances their own facade objects', () => {
    const a = createPluginContext(widgetEntry(), 'demo:1', hostInfo);
    const b = createPluginContext(widgetEntry(), 'demo:2', hostInfo);

    expect(a.rciManager).not.toBe(b.rciManager);
    expect(a.sessionManager).not.toBe(b.sessionManager);
  });
});
