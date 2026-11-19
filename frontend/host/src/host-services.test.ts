// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {createHostServices} from './host-services.js';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

describe('host service composition', () => {
  it('creates an isolated service graph for each app', () => {
    const first = createHostServices();
    const second = createHostServices();

    expect(first.mgmtClient).not.toBe(second.mgmtClient);
    expect(first.palette).not.toBe(second.palette);
    expect(first.locale).not.toBe(second.locale);
    expect(first.registry).not.toBe(second.registry);
    expect(first.catalog).not.toBe(second.catalog);
    expect(first.router).not.toBe(second.router);
    expect(first.opkgClient).not.toBe(second.opkgClient);
    expect(first.serviceClient).not.toBe(second.serviceClient);
    expect(first.selfUpdateClient).not.toBe(second.selfUpdateClient);
    expect(first.persistentRci).not.toBe(second.persistentRci);
    expect(first.telemetryGathering).not.toBe(second.telemetryGathering);
    expect(first.rci).not.toBe(second.rci);
    expect(first.overlay).not.toBe(second.overlay);
    expect(first.theme).not.toBe(second.theme);
    expect(first.tickerPool).not.toBe(second.tickerPool);
    expect(first.pluginStylesheets).not.toBe(second.pluginStylesheets);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('keeps locale and theme changes inside their service graph', async () => {
    const firstStorage = new Map<string, string>();
    const secondStorage = new Map<string, string>();
    const first = createHostServices({
      storage: {
        getItem: (key) => firstStorage.get(key) ?? null,
        setItem: (key, value) => firstStorage.set(key, value),
      },
    });
    const second = createHostServices({
      storage: {
        getItem: (key) => secondStorage.get(key) ?? null,
        setItem: (key, value) => secondStorage.set(key, value),
      },
    });

    first.locale.initLocale();
    second.locale.initLocale();
    first.theme.initTheme();
    second.theme.initTheme();
    await first.locale.setLocale('ru');
    first.theme.setTheme('light');

    expect(first.locale.getLocale()).toBe('ru');
    expect(second.locale.getLocale()).toBe('en');
    expect(first.theme.getTheme()).toBe('light');
    expect(second.theme.getTheme()).toBe('dark');
  });

  it('connects injected environment boundaries to one service graph', () => {
    const isolatedDocument = document.implementation.createHTMLDocument('isolated');
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => stored.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        stored.set(key, value);
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const setUiLocale = vi.fn();
    const services = createHostServices({fetch, document: isolatedDocument, storage, setUiLocale});

    services.locale.initLocale();

    expect(services.palette).toBeDefined();
    expect(services.catalog).toBeDefined();
    expect(services.registry).toBeDefined();
    expect(services.locale.getLocale()).toBe('en');
    expect(isolatedDocument.documentElement.lang).toBe('en');
    expect(setUiLocale).toHaveBeenCalledWith('en');
    expect(storage.getItem('mndw:locale')).toBeNull();
  });

  it('builds management REST clients with the graph fetch implementation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      const body = url.endsWith('/opkg/list')
        ? {packages: [], metadataUpdatedAt: null}
        : url.endsWith('/service/list')
        ? {services: []}
        : {state: 'idle', version: '1.0.0'};

      return Promise.resolve(
        new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}}),
      );
    });
    const services = createHostServices({fetch});

    await expect(services.opkgClient.list()).resolves.toEqual({packages: [], metadataUpdatedAt: null});
    await expect(services.serviceClient.list()).resolves.toEqual([]);
    await expect(services.selfUpdateClient.status()).resolves.toEqual({state: 'idle', version: '1.0.0'});

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      '/api/mgmt/opkg/list',
      '/api/mgmt/service/list',
      '/api/mgmt/self-update/status',
    ]);
  });
});
