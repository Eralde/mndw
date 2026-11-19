// @vitest-environment happy-dom
import 'zone.js';
import '@angular/compiler';
import {Component} from '@angular/core';
import {type PluginContext, type PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance} from '@mndw/sdk/angular';
import {createTestPluginContext} from '@mndw/sdk/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {mountPlugin, mountPluginWithContext} from './plugin-lifecycle.js';
import type {PluginContextHandle} from './plugin-context.js';
import type {LoadedPlugin} from './plugin-registry.js';
import {PluginStylesheets} from './plugin-stylesheets.js';

const pluginStylesheets = new PluginStylesheets();

@Component({selector: 'throwing-angular-root', standalone: true, template: ''})
class ThrowingAngularRootComponent {
  constructor() {
    throw new Error('angular mount failed');
  }
}

@Component({selector: 'late-angular-root', standalone: true, template: 'mounted'})
class LateAngularRootComponent {}

vi.mock('../services/storage.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/storage.service.js')>();

  return {...actual, clearInstanceStorage: vi.fn(actual.clearInstanceStorage)};
});

beforeEach(async () => {
  (window as unknown as {happyDOM: {settings: {disableCSSFileLoading: boolean}}})
    .happyDOM.settings.disableCSSFileLoading = true;
  const {clearInstanceStorage} = await import('../services/storage.service.js');

  vi.mocked(clearInstanceStorage).mockClear();
  localStorage.clear();
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
  return createTestPluginContext({instanceId}).context;
}

function mockContextHandle(instanceId = 'test:1'): PluginContextHandle {
  return {context: mockContext(instanceId), dispose: vi.fn()};
}

function loadedStylesheet(): {link: HTMLLinkElement; release: () => void} {
  const lease = pluginStylesheets.acquire('test-plugin', '1.0.0', '/test-plugin.css?v=1.0.0');
  const link = document.head.querySelector<HTMLLinkElement>('link[data-plugin-style="test-plugin"]');

  if (link === null) {
    throw new Error('Test stylesheet was not added');
  }

  link.dispatchEvent(new Event('load'));

  return {link, release: () => lease.release()};
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
    const handle = mountPluginWithContext(container, plugin, mockContextHandle());

    await expect(handle.whenReady()).resolves.toBe(true);

    expect(handle.getMounted()?.instance).toBe(instance);
    handle.dispose();
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

  it('shows the host plugin error state when an Angular mount rejects', async () => {
    const plugin = mockPlugin(Promise.resolve(mockInstance().instance));
    const container = document.createElement('div');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    plugin.module.createInstance = (el) =>
      createAngularPluginInstance(el, {
        rootComponent: ThrowingAngularRootComponent,
        providers: [],
      });

    const result = mountPlugin(container, plugin, mockContext(), noopDispose, {errorText: 'Error loading widget'});

    expect(result).toBeInstanceOf(Promise);

    const mounted = await result;

    expect(mounted).toBeNull();
    expect(container.textContent).toBe('Error loading widget');
    expect(errorSpy).toHaveBeenCalledWith(
      '[mndw] Plugin "test-plugin" createInstance failed:',
      expect.any(Error),
    );
  });

  it('unmounts an Angular instance that resolves after host disposal', async () => {
    const plugin = mockPlugin(Promise.resolve(mockInstance().instance));
    const container = document.createElement('div');
    const componentDestroy = vi.fn();

    plugin.module.createInstance = (el) =>
      createAngularPluginInstance(el, {
        rootComponent: LateAngularRootComponent,
        providers: [],
        configure: ({component}) => {
          const destroy = component.destroy.bind(component);

          vi.spyOn(component, 'destroy').mockImplementation(() => {
            componentDestroy();
            destroy();
          });
        },
      });

    const handle = mountPluginWithContext(container, plugin, mockContextHandle());

    handle.dispose();
    await handle.whenReady();

    expect(handle.getMounted()).toBeNull();
    expect(componentDestroy).toHaveBeenCalledOnce();
    expect(container.childNodes.length).toBe(0);
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

describe('PluginMountHandle.dispose', () => {
  it('calls instance.unmount() and clears DOM', () => {
    const {instance, unmountSpy} = mockInstance();
    const container = document.createElement('div');

    container.innerHTML = '<div>content</div>';

    const handle = mountPluginWithContext(container, mockPlugin(instance), mockContextHandle());

    handle.dispose();

    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe('');
  });

  it('clears storage by default', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const {instance} = mockInstance();
    const handle = mountPluginWithContext(document.createElement('div'), mockPlugin(instance), mockContextHandle());

    handle.dispose();

    expect(clearInstanceStorage).toHaveBeenCalledWith('test-plugin', 'test:1');
  });

  it('does not clear storage when clearStorage: false', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const {instance} = mockInstance();
    const handle = mountPluginWithContext(document.createElement('div'), mockPlugin(instance), mockContextHandle());

    handle.dispose({clearStorage: false});

    expect(clearInstanceStorage).not.toHaveBeenCalled();
  });

  it('clears the container when disposed while createInstance is pending', async () => {
    let finishMount: (instance: PluginInstance) => void = () => {};
    const pending = new Promise<PluginInstance>((resolve) => {
      finishMount = resolve;
    });
    const container = document.createElement('div');
    const handle = mountPluginWithContext(container, mockPlugin(pending), mockContextHandle());

    container.innerHTML = '<div>content</div>';
    handle.dispose();

    expect(container.innerHTML).toBe('');

    finishMount(mockInstance().instance);
    await handle.whenReady();
  });

  it('closes plugin-owned overlays before unmounting the instance', () => {
    const closeAll = vi.fn();
    const {instance, unmountSpy} = mockInstance();
    const contextHandle: PluginContextHandle = {context: mockContext(), dispose: closeAll};
    const handle = mountPluginWithContext(document.createElement('div'), mockPlugin(instance), contextHandle);

    handle.dispose();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(unmountSpy).toHaveBeenCalledTimes(1);
    expect(closeAll.mock.invocationCallOrder[0]).toBeLessThan(unmountSpy.mock.invocationCallOrder[0]);
  });

  it('does not throw when instance.unmount() throws', () => {
    const {instance} = mockInstance();

    instance.unmount = () => {
      throw new Error('unmount failed');
    };

    const handle = mountPluginWithContext(document.createElement('div'), mockPlugin(instance), mockContextHandle());

    expect(() => handle.dispose()).not.toThrow();
  });

  it('logs when async instance.unmount() rejects while cleanup remains synchronous', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const error = new Error('async unmount failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeAll = vi.fn();
    const container = document.createElement('div');
    const instance: PluginInstance = {unmount: vi.fn(() => Promise.reject(error))};
    const contextHandle: PluginContextHandle = {context: mockContext(), dispose: closeAll};

    container.innerHTML = '<div>content</div>';

    const handle = mountPluginWithContext(container, mockPlugin(instance), contextHandle);

    handle.dispose();

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(clearInstanceStorage).toHaveBeenCalledWith('test-plugin', 'test:1');
    expect(container.innerHTML).toBe('');

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('[mndw] Plugin "test-plugin" unmount failed:', error);
    });

    consoleError.mockRestore();
  });
});

describe('mountPluginWithContext', () => {
  it('holds stylesheet through async unmount after registry removal', async () => {
    const stylesheet = loadedStylesheet();
    let finishUnmount: () => void = () => {};
    const unmounting = new Promise<void>((resolve) => {
      finishUnmount = resolve;
    });
    const plugin = mockPlugin({unmount: () => unmounting});
    const handle = mountPluginWithContext(document.createElement('div'), plugin, mockContextHandle(), {
      pluginStylesheets,
    });

    stylesheet.release();
    expect(stylesheet.link.isConnected).toBe(true);

    handle.dispose();
    expect(stylesheet.link.isConnected).toBe(true);

    finishUnmount();
    await vi.waitFor(() => expect(stylesheet.link.isConnected).toBe(false));
  });

  it('releases stylesheet when async createInstance rejects', async () => {
    const stylesheet = loadedStylesheet();
    let rejectMount: (error: Error) => void = () => {};
    const mounting = new Promise<PluginInstance>((_resolve, reject) => {
      rejectMount = reject;
    });
    const result = mountPlugin(
      document.createElement('div'),
      mockPlugin(mounting),
      mockContext(),
      () => {},
      {pluginStylesheets},
    );

    if (!(result instanceof Promise)) {
      throw new Error('Expected asynchronous plugin mount');
    }

    stylesheet.release();
    expect(stylesheet.link.isConnected).toBe(true);

    rejectMount(new Error('async mount failed'));
    await expect(result).resolves.toBeNull();

    expect(stylesheet.link.isConnected).toBe(false);
  });

  it('keeps stylesheet for a late mount until its cleanup settles', async () => {
    const stylesheet = loadedStylesheet();
    let finishMount: (instance: PluginInstance) => void = () => {};
    let finishUnmount: () => void = () => {};
    const mounting = new Promise<PluginInstance>((resolve) => {
      finishMount = resolve;
    });
    const unmounting = new Promise<void>((resolve) => {
      finishUnmount = resolve;
    });
    const handle = mountPluginWithContext(
      document.createElement('div'),
      mockPlugin(mounting),
      mockContextHandle(),
      {pluginStylesheets},
    );

    handle.dispose();
    stylesheet.release();
    expect(stylesheet.link.isConnected).toBe(true);

    finishMount({unmount: () => unmounting});
    await handle.whenReady();

    expect(stylesheet.link.isConnected).toBe(true);

    finishUnmount();
    await vi.waitFor(() => expect(stylesheet.link.isConnected).toBe(false));
  });

  it('clears failed mount storage on explicit disposal without touching other storage', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const plugin = mockPlugin(mockInstance().instance);
    plugin.module.createInstance = vi.fn(() => {
      throw new Error('sync fail');
    });
    const contextHandle = mockContextHandle('test:1');
    const container = document.createElement('div');
    localStorage.setItem('mndw:plugin:test-plugin:instance:test:1:settings', 'remove');
    localStorage.setItem('mndw:plugin:test-plugin:instance:test:2:settings', 'keep');
    localStorage.setItem('mndw:plugin:test-plugin:shared:settings', 'keep');

    const handle = mountPluginWithContext(container, plugin, contextHandle);

    expect(handle.getMounted()).toBeNull();
    handle.dispose({clearStorage: true});

    expect(clearInstanceStorage).toHaveBeenCalledWith('test-plugin', 'test:1');
    expect(localStorage.getItem('mndw:plugin:test-plugin:instance:test:1:settings')).toBeNull();
    expect(localStorage.getItem('mndw:plugin:test-plugin:instance:test:2:settings')).toBe('keep');
    expect(localStorage.getItem('mndw:plugin:test-plugin:shared:settings')).toBe('keep');
  });

  it('clears storage when a pending mount later fails after explicit disposal', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    let rejectMount: (error: Error) => void = () => {
      throw new Error('mount rejection handler was not initialized');
    };
    const pending = new Promise<PluginInstance>((_resolve, reject) => {
      rejectMount = reject;
    });
    const contextHandle = mockContextHandle('test:1');
    const container = document.createElement('div');
    localStorage.setItem('mndw:plugin:test-plugin:instance:test:1:settings', 'remove');
    const handle = mountPluginWithContext(container, mockPlugin(pending), contextHandle);

    handle.dispose({clearStorage: true});
    rejectMount(new Error('async fail'));
    await handle.whenReady();

    expect(clearInstanceStorage).toHaveBeenCalledWith('test-plugin', 'test:1');
    expect(localStorage.getItem('mndw:plugin:test-plugin:instance:test:1:settings')).toBeNull();
  });

  it('keeps failed mount storage when disposal explicitly disables clearing', () => {
    const plugin = mockPlugin(mockInstance().instance);
    plugin.module.createInstance = vi.fn(() => {
      throw new Error('sync fail');
    });
    localStorage.setItem('mndw:plugin:test-plugin:instance:test:1:settings', 'keep');
    const handle = mountPluginWithContext(document.createElement('div'), plugin, mockContextHandle('test:1'));

    handle.dispose({clearStorage: false});

    expect(localStorage.getItem('mndw:plugin:test-plugin:instance:test:1:settings')).toBe('keep');
  });
});
