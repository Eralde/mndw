import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import drawerStyles from './components/node-drawer/node-drawer.component.scss?raw';
import drawerTemplate from './components/node-drawer/node-drawer.component.html?raw';
import clientsTableStyles from './components/clients-table/clients-table.component.scss?raw';
import clientsTableTemplate from './components/clients-table/clients-table.component.html?raw';
import nodesTableStyles from './components/nodes-table/nodes-table.component.scss?raw';
import nodesTableTemplate from './components/nodes-table/nodes-table.component.html?raw';
import graphStyles from './components/mws-graph/mws-graph.component.scss?raw';
import appStyles from './app/app.component.scss?raw';
import appTemplate from './app/app.component.html?raw';
import {createInstance} from './index';
import {FakePluginStorage} from './test-support/plugin-storage.fake';

function fakeContext(backend: BackendClient | null = null): {
  ctx: PluginContext;
  closeAll: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  queue: ReturnType<typeof vi.fn>;
} {
  const closeAll = vi.fn();
  const unsubscribe = vi.fn();
  const queue = vi.fn(() => of({}));
  const ctx = {
    rciManager: {queue},
    backend,
    storage: new FakePluginStorage(),
    sharedStorage: {},
    hostInfo: {deviceName: 'Router', vendor: 'Keenetic', firmwareVersion: '5.1.1', theme: 'light'},
    injector: {},
    instanceId: 'test',
    onThemeChange: vi.fn(() => unsubscribe),
    overlay: {open: vi.fn(), createLayer: vi.fn(), closeAll},
  } as unknown as PluginContext;

  return {ctx, closeAll, unsubscribe, queue};
}

describe('createInstance', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await resolveComponentResources((url: string) => {
      if (url.endsWith('app.component.html')) {
        return Promise.resolve(appTemplate);
      }

      if (url.endsWith('app.component.scss')) {
        return Promise.resolve(appStyles);
      }

      if (url.endsWith('mws-graph.component.scss')) {
        return Promise.resolve(graphStyles);
      }

      if (url.endsWith('clients-table.component.html')) {
        return Promise.resolve(clientsTableTemplate);
      }

      if (url.endsWith('clients-table.component.scss')) {
        return Promise.resolve(clientsTableStyles);
      }

      if (url.endsWith('nodes-table.component.html')) {
        return Promise.resolve(nodesTableTemplate);
      }

      if (url.endsWith('nodes-table.component.scss')) {
        return Promise.resolve(nodesTableStyles);
      }

      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    vi.useRealTimers();
  });

  it('tolerates unmount before Angular bootstrap resolves and leaves the mount empty', async () => {
    const {ctx, closeAll, unsubscribe} = fakeContext();
    const el = document.createElement('div');
    const instance = createInstance(el, ctx);

    instance.unmount();
    await vi.runAllTimersAsync();

    expect(el.childNodes.length).toBe(0);
    expect(closeAll).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('mounts the app and tears it down on unmount', async () => {
    const {ctx, closeAll} = fakeContext();
    const el = document.createElement('div');
    const instance = createInstance(el, ctx);

    await vi.waitFor(() => {
      expect(el.querySelector('mws-map-app, .mws-page')).not.toBeNull();
    });

    instance.unmount();
    expect(el.childNodes.length).toBe(0);
    expect(closeAll).toHaveBeenCalledOnce();
  });

  it('reflects the host theme on the mount element and follows changes', () => {
    const {ctx} = fakeContext();
    const el = document.createElement('div');
    const instance = createInstance(el, ctx);

    expect(el.dataset.mndwTheme).toBe('light');

    const callback = (ctx.onThemeChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as (theme: string) => void;

    callback('dark');
    expect(el.dataset.mndwTheme).toBe('dark');
    instance.unmount();
  });

  it('activates parameterized large mock mode from the URL', async () => {
    window.history.replaceState({}, '', '/mws?mock=large&extenders=3&clients=7');

    const fetch = vi.fn();
    const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;
    const {ctx, queue} = fakeContext(backend);
    const el = document.createElement('div');
    const instance = createInstance(el, ctx);

    await vi.waitFor(() => {
      expect(el.textContent).toContain('Mock data: 3 extenders · 7 clients');
    });

    expect(queue).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('uses live RCI service when mock query is absent', async () => {
    window.history.replaceState({}, '', '/mws');

    const fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({credState: 'present', nodes: []}), {status: 200}))
    );
    const backend = {
      fetch,
      socket: vi.fn(),
    } as unknown as BackendClient;
    const {ctx, queue} = fakeContext(backend);
    const el = document.createElement('div');
    const instance = createInstance(el, ctx);

    await vi.waitFor(() => {
      expect(queue).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('nodes', expect.anything());
    });

    instance.unmount();
  });
});
