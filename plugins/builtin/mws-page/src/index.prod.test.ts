import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import type {BackendClient, PluginContext} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
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
import {createInstance} from './index.prod';
import {FakePluginStorage} from './test-support/plugin-storage.fake';
import enCatalog from '../i18n/en.json';

function fakeContext(backend: BackendClient | null = null): {ctx: PluginContext; queue: ReturnType<typeof vi.fn>} {
  const unsubscribe = vi.fn();
  const queue = vi.fn(() => of({}));
  const ctx = {
    rciManager: {queue},
    backend,
    storage: new FakePluginStorage(),
    sharedStorage: {},
    hostInfo: {locale: 'en', theme: 'light'},
    deviceInfo: {deviceName: 'Router'},
    injector: {},
    instanceId: 'test',
    onThemeChange: vi.fn(() => unsubscribe),
    overlay: {open: vi.fn(), createLayer: vi.fn(), closeAll: vi.fn()},
    i18n: createTestI18n(enCatalog),
  } as unknown as PluginContext;

  return {ctx, queue};
}

describe('production createInstance', () => {
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

  it('uses live RCI even when large mock query is present', async () => {
    window.history.replaceState({}, '', '/mws?mock=large&extenders=3&clients=7');

    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({lastRefreshAt: new Date().toISOString(), persistentAvailable: true, persistentSessions: []}),
          {status: 200},
        ),
      )
    );
    const backend = {
      fetch,
      socket: vi.fn(),
      status: vi.fn(),
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
