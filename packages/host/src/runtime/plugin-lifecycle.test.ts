import type {PluginContext, PluginInstance} from '@mndw/sdk';
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
      size: {w: 4, h: 3},
      backend: {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false},
    },
    module: {createInstance: vi.fn(() => createInstanceResult)},
  };
}

function mockContext(instanceId = 'test:1'): PluginContext {
  return {
    rciManager: {} as never,
    sessionManager: {} as never,
    storage: {} as never,
    sharedStorage: {} as never,
    hostInfo: {deviceName: 'Test', vendor: 'Test', firmwareVersion: '1.0', theme: 'dark'},
    injector: {} as never,
    instanceId,
    backend: undefined,
    onThemeChange: () => () => {},
    overlay: {createLayer: vi.fn(), open: vi.fn(), closeAll: vi.fn()} as never,
  };
}

describe('mountPlugin', () => {
  it('returns a MountedPlugin immediately for sync createInstance', () => {
    const {instance} = mockInstance();
    const result = mountPlugin(document.createElement('div'), mockPlugin(instance), mockContext());

    expect(result).not.toBeNull();

    if (result && !(result instanceof Promise)) {
      expect(result.pluginName).toBe('test-plugin');
      expect(result.instance).toBe(instance);
    }
  });

  it('resolves and returns a MountedPlugin for async createInstance', async () => {
    const {instance} = mockInstance();
    const result = mountPlugin(document.createElement('div'), mockPlugin(Promise.resolve(instance)), mockContext());

    expect(result).toBeInstanceOf(Promise);

    const mounted = await result;

    expect(mounted).not.toBeNull();
    expect(mounted?.pluginName).toBe('test-plugin');
  });

  it('returns null when sync createInstance throws', () => {
    const plugin = mockPlugin(Promise.resolve(mockInstance().instance));

    plugin.module.createInstance = vi.fn(() => {
      throw new Error('sync fail');
    });

    const container = document.createElement('div');
    const result = mountPlugin(container, plugin, mockContext(), {errorText: 'Error loading widget'});

    expect(result).toBeNull();
    expect(container.textContent).toBe('Error loading widget');
  });

  it('returns null when async createInstance rejects', async () => {
    const plugin = mockPlugin(Promise.reject(new Error('async fail')));
    const container = document.createElement('div');
    const result = mountPlugin(container, plugin, mockContext(), {errorText: 'Error loading widget'});

    expect(result).toBeInstanceOf(Promise);

    const mounted = await result;

    expect(mounted).toBeNull();
    expect(container.textContent).toBe('Error loading widget');
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
});
