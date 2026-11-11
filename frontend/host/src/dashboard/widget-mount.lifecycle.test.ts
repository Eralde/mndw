// @vitest-environment happy-dom
import type {PluginContextHandle} from '../runtime/plugin-context.js';
import type {LoadedPlugin} from '../runtime/plugin-registry.js';
import type {PluginContext} from '@mndw/sdk';
import {createTestPluginContext} from '@mndw/sdk/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {mountWidgetTile} from './widget-mount.js';

vi.mock('../services/storage.service.js', () => ({clearInstanceStorage: vi.fn()}));

beforeEach(async () => {
  const {clearInstanceStorage} = await import('../services/storage.service.js');

  vi.mocked(clearInstanceStorage).mockClear();
});

describe('mountWidgetTile pending context disposal', () => {
  it('disposes context immediately and unmounts a late instance once', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const fixture = createTestPluginContext({instanceId: 'test-plugin:1'});
    let resolveInstance!: (instance: {unmount: () => void}) => void;
    const pending = new Promise<{unmount: () => void}>((resolve) => {
      resolveInstance = resolve;
    });
    const closeOverlay = vi.fn();
    const openOverlay = vi.fn(() => ({closeWithReason: closeOverlay}));
    const context = Object.freeze({
      ...fixture.context,
      overlay: {...fixture.context.overlay, open: openOverlay},
    }) as unknown as PluginContext;
    const ticker = context.createTicker();
    const tickerStopped = vi.fn();

    ticker.tick$.subscribe({complete: tickerStopped});
    ticker.start(1000);

    const dispose = vi.fn((reason?: 'plugin-unmount' | 'host-navigation') => {
      if (reason !== undefined) {
        closeOverlay(reason);
      }

      fixture.unmount();
    });
    const contextHandle: PluginContextHandle = {context, dispose};
    const plugin = {
      entry: {name: 'test-plugin'},
      module: {createInstance: vi.fn((_container: HTMLElement, ctx: PluginContext) => {
        ctx.overlay.open({kind: 'modal', mount: vi.fn()} as never);

        return pending;
      })},
    } as unknown as LoadedPlugin;
    const container = document.createElement('div');
    const tile = mountWidgetTile(container, plugin, contextHandle);
    const instanceUnmount = vi.fn();

    expect(fixture.context.signal.aborted).toBe(false);

    tile.dispose({clearStorage: false, closeReason: 'host-navigation'});

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith('host-navigation');
    expect(fixture.context.signal.aborted).toBe(true);
    expect(openOverlay).toHaveBeenCalledOnce();
    expect(closeOverlay).toHaveBeenCalledWith('host-navigation');
    expect(tickerStopped).toHaveBeenCalledOnce();

    tile.dispose({clearStorage: true, closeReason: 'plugin-unmount'});
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith('host-navigation');

    resolveInstance({unmount: instanceUnmount});

    expect(await tile.whenReady()).toBe(true);
    expect(instanceUnmount).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(clearInstanceStorage).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('reports pending rejection and disposes context once', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const fixture = createTestPluginContext({instanceId: 'test-plugin:1'});
    let rejectInstance!: (error: Error) => void;
    const pending = new Promise<{unmount: () => void}>((_, reject) => {
      rejectInstance = reject;
    });
    const dispose = vi.fn(() => fixture.unmount());
    const contextHandle: PluginContextHandle = {context: fixture.context, dispose};
    const plugin = {
      entry: {name: 'test-plugin'},
      module: {createInstance: vi.fn(() => pending)},
    } as unknown as LoadedPlugin;
    const tile = mountWidgetTile(document.createElement('div'), plugin, contextHandle);
    const error = new Error('initialization failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ready = tile.whenReady();

    rejectInstance(error);

    await expect(ready).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith('plugin-unmount');
    expect(fixture.context.signal.aborted).toBe(true);
    expect(clearInstanceStorage).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('clears instance storage on late resolution unless asked to preserve it', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const fixture = createTestPluginContext({instanceId: 'test-plugin:1'});
    let resolveInstance!: (instance: {unmount: () => void}) => void;
    const pending = new Promise<{unmount: () => void}>((resolve) => {
      resolveInstance = resolve;
    });
    const contextHandle: PluginContextHandle = {
      context: fixture.context,
      dispose: vi.fn(() => fixture.unmount()),
    };
    const plugin = {
      entry: {name: 'test-plugin'},
      module: {createInstance: vi.fn(() => pending)},
    } as unknown as LoadedPlugin;
    const tile = mountWidgetTile(document.createElement('div'), plugin, contextHandle);

    tile.dispose();
    resolveInstance({unmount: vi.fn()});
    await tile.whenReady();

    expect(clearInstanceStorage).toHaveBeenCalledOnce();
    expect(clearInstanceStorage).toHaveBeenCalledWith('test-plugin', 'test-plugin:1');
  });
});
