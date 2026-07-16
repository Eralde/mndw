import {describe, expect, it, vi} from 'vitest';
import {createPluginContext} from './plugin-context.js';
import type {PluginBackendDescriptor, WidgetListEntry} from './plugin-types.js';

vi.mock('../services/rci.service.js', () => ({rciService: {driver: {}, auth: {}}}));
vi.mock('../services/storage.service.js', () => ({
  ScopedPluginStorage: class {
    constructor(_prefix: string) {}
  },
}));
vi.mock('../services/injector.service.js', () => ({injector: {}}));
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

describe('createPluginContext', () => {
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
});
