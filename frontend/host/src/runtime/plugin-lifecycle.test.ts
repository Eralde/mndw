import {MNDW_TOKENS, type PluginContext, type PluginInstance} from '@mndw/sdk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {mountPlugin, unmountPlugin} from './plugin-lifecycle.js';
import type {LoadedPlugin} from './plugin-registry.js';

vi.mock('../services/storage.service.js', () => ({
  clearInstanceStorage: vi.fn(),
}));

beforeEach(async () => {
  const {clearInstanceStorage} = await import('../services/storage.service.js');

  vi.mocked(clearInstanceStorage).mockClear();
});

function mockInstance(): {instance: PluginInstance; unmountSpy: ReturnType<typeof vi.fn>} {
  const unmountSpy = vi.fn();

  return {instance: {unmount: unmountSpy}, unmountSpy};
}

function mockPlugin(createInstanceResult: PluginInstance | Promise<PluginInstance>): LoadedPlugin {
  return {
    entry: {
      name: 'test-plugin',
      type: 'widget',
      version: '1.0.0',
      label: 'Test',
      entry: 'index.js',
      source: 'builtin',
      approval: 'approved',
      enabled: true,
      depsStatus: 'ready',
      size: {w: 4, h: 3},
      backend: {routes: {}},
    },
    module: {createInstance: vi.fn(() => createInstanceResult)},
  };
}

function mockContext(instanceId = 'test:1'): PluginContext {
  return {
    kind: 'widget',
    rciManager: {} as never,
    storage: {} as never,
    sharedStorage: {} as never,
    hostInfo: {locale: 'en', theme: 'dark'},
    deviceInfo: {
      deviceName: 'Test',
      vendor: 'Test',
      manufacturer: 'Test',
      model: 'Test',
      series: 'Test',
      region: 'test',
      hwId: 'test',
      hwVersion: '1',
      firmwareVersion: '1.0',
      firmwareRelease: '1.0',
      features: [],
      components: [],
      switchports: {list: [], layout: [], hasPortStats: false},
      usb: {ports: []},
      hasFeature: () => false,
      hasComponent: () => false,
    },
    i18n: {
      locale: 'en',
      direction: 'ltr',
      t: (key: string) => key,
      formatNumber: (value: number) => String(value),
      formatDate: (value: Date) => value.toISOString(),
      onChange: () => () => {},
    },
    injector: {} as never,
    instanceId,
    backend: undefined,
    onThemeChange: () => () => {},
    getTokens: () => MNDW_TOKENS,
    onPaletteChange: () => () => {},
    overlay: {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as never,
  };
}

describe('mountPlugin', () => {
  const noopDispose = vi.fn();

  it('returns a MountedPlugin immediately for sync createInstance', () => {
    const {instance} = mockInstance();
    const result = mountPlugin(document.createElement('div'), mockPlugin(instance), mockContext(), noopDispose);

    expect(result).not.toBeNull();

    if (result && !(result instanceof Promise)) {
      expect(result.pluginName).toBe('test-plugin');
      expect(result.instance).toBe(instance);
    }
  });

  it('resolves and returns a MountedPlugin for async createInstance', async () => {
    const {instance} = mockInstance();
    const result = mountPlugin(
      document.createElement('div'),
      mockPlugin(Promise.resolve(instance)),
      mockContext(),
      noopDispose,
    );

    expect(result).toBeInstanceOf(Promise);

    const mounted = await result;

    expect(mounted).not.toBeNull();
    expect(mounted?.pluginName).toBe('test-plugin');
  });

  it('resolves promise-like createInstance results from patched Promise environments', async () => {
    const {instance, unmountSpy} = mockInstance();
    const plugin = mockPlugin(instance);

    plugin.module.createInstance = vi.fn(() => ({
      then(resolve: (value: PluginInstance) => void): void {
        resolve(instance);
      },
    } as unknown as Promise<PluginInstance>));

    const container = document.createElement('div');
    const result = mountPlugin(container, plugin, mockContext(), noopDispose);

    expect(result).toBeInstanceOf(Promise);

    const mounted = await result;

    expect(mounted?.instance).toBe(instance);
    unmountPlugin(mounted, container);
    expect(unmountSpy).toHaveBeenCalledOnce();
  });

  it('returns null when sync createInstance throws', () => {
    const plugin = mockPlugin(Promise.resolve(mockInstance().instance));

    plugin.module.createInstance = vi.fn(() => {
      throw new Error('sync fail');
    });

    const container = document.createElement('div');
    const result = mountPlugin(container, plugin, mockContext(), noopDispose, {errorText: 'Error loading widget'});

    expect(result).toBeNull();
    expect(container.textContent).toBe('Error loading widget');
  });

  it('returns null when async createInstance rejects', async () => {
    const plugin = mockPlugin(Promise.reject(new Error('async fail')));
    const container = document.createElement('div');
    const result = mountPlugin(container, plugin, mockContext(), noopDispose, {errorText: 'Error loading widget'});

    expect(result).toBeInstanceOf(Promise);

    const mounted = await result;

    expect(mounted).toBeNull();
    expect(container.textContent).toBe('Error loading widget');
  });

  it('disposes the overlay service when sync createInstance throws', () => {
    const plugin = mockPlugin(Promise.resolve(mockInstance().instance));

    plugin.module.createInstance = vi.fn(() => {
      throw new Error('sync fail');
    });

    const dispose = vi.fn();

    void mountPlugin(document.createElement('div'), plugin, mockContext(), dispose, {errorText: 'x'});

    expect(dispose).toHaveBeenCalledWith('plugin-unmount');
  });

  it('disposes the overlay service when async createInstance rejects', async () => {
    const plugin = mockPlugin(Promise.reject(new Error('async fail')));
    const dispose = vi.fn();

    await mountPlugin(document.createElement('div'), plugin, mockContext(), dispose, {errorText: 'x'});

    expect(dispose).toHaveBeenCalledWith('plugin-unmount');
  });

  it('retains the passed disposer on a successful sync mount', () => {
    const {instance} = mockInstance();
    const dispose = vi.fn();

    const mounted = mountPlugin(document.createElement('div'), mockPlugin(instance), mockContext(), dispose);

    expect(mounted).not.toBeNull();

    if (mounted instanceof Promise) {
      throw new Error('Expected synchronous mount');
    }

    expect(mounted?.disposeOverlayService).toBe(dispose);
  });

  it('retains the passed disposer on a successful async mount', async () => {
    const {instance} = mockInstance();
    const dispose = vi.fn();

    const mounted = await mountPlugin(
      document.createElement('div'),
      mockPlugin(Promise.resolve(instance)),
      mockContext(),
      dispose,
    );

    expect(mounted).not.toBeNull();
    expect(mounted?.disposeOverlayService).toBe(dispose);
  });
});

describe('unmountPlugin', () => {
  it('calls instance.unmount() and clears DOM', () => {
    const {instance, unmountSpy} = mockInstance();
    const container = document.createElement('div');

    container.innerHTML = '<div>content</div>';

    unmountPlugin({pluginName: 'test', instanceId: 'test:1', instance}, container);

    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe('');
  });

  it('clears storage by default', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const {instance} = mockInstance();

    unmountPlugin({pluginName: 'test', instanceId: 'test:1', instance}, document.createElement('div'));

    expect(clearInstanceStorage).toHaveBeenCalledWith('test', 'test:1');
  });

  it('does not clear storage when clearStorage: false', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const {instance} = mockInstance();

    unmountPlugin(
      {pluginName: 'test', instanceId: 'test:1', instance},
      document.createElement('div'),
      {clearStorage: false},
    );

    expect(clearInstanceStorage).not.toHaveBeenCalled();
  });

  it('handles null mounted by clearing the container', () => {
    const container = document.createElement('div');

    container.innerHTML = '<div>content</div>';

    unmountPlugin(null, container);

    expect(container.innerHTML).toBe('');
  });

  it('closes plugin-owned overlays before unmounting the instance', () => {
    const closeAll = vi.fn();
    const {instance, unmountSpy} = mockInstance();

    unmountPlugin(
      {pluginName: 'test', instanceId: 'test:1', instance, disposeOverlayService: closeAll},
      document.createElement('div'),
    );

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(closeAll.mock.invocationCallOrder[0]).toBeLessThan(unmountSpy.mock.invocationCallOrder[0]);
  });

  it('does not throw when instance.unmount() throws', () => {
    const {instance} = mockInstance();

    instance.unmount = () => {
      throw new Error('unmount failed');
    };

    expect(() => unmountPlugin({pluginName: 'test', instanceId: 'test:1', instance}, document.createElement('div'))).not
      .toThrow();
  });

  it('logs when async instance.unmount() rejects while cleanup remains synchronous', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const error = new Error('async unmount failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeAll = vi.fn();
    const container = document.createElement('div');
    const instance: PluginInstance = {unmount: vi.fn(() => Promise.reject(error))};

    container.innerHTML = '<div>content</div>';

    unmountPlugin({pluginName: 'test', instanceId: 'test:1', instance, disposeOverlayService: closeAll}, container);

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(clearInstanceStorage).toHaveBeenCalledWith('test', 'test:1');
    expect(container.innerHTML).toBe('');

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('[mndw] Plugin "test" unmount failed:', error);
    });

    consoleError.mockRestore();
  });
});
