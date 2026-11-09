// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {appHostServices, createHostServices} from './host-services.js';
import {localeService} from './services/locale.service.js';
import {mgmtClient} from './services/mgmt-client.js';
import {paletteService} from './services/palette.service.js';
import {pluginRegistry} from './runtime/plugin-registry.js';

describe('host service composition', () => {
  it('uses the application singletons in one memoized service graph', () => {
    const services = appHostServices();

    expect(services.locale).toBe(localeService);
    expect(services.palette).toBe(paletteService);
    expect(services.registry).toBe(pluginRegistry);
    expect(services.mgmtClient).toBe(mgmtClient);
    expect(services.telemetryGathering).toBeDefined();
    expect(appHostServices()).toBe(services);
    expect(Object.isFrozen(services)).toBe(true);
  });

  it('creates isolated migratable service instances and caches production graph', () => {
    const first = createHostServices();
    const second = createHostServices();

    expect(first.mgmtClient).not.toBe(second.mgmtClient);
    expect(first.palette).not.toBe(second.palette);
    expect(first.locale).not.toBe(second.locale);
    expect(first.registry).not.toBe(second.registry);
    expect(first.catalog).not.toBe(second.catalog);
    expect(first.persistentRci).not.toBe(second.persistentRci);
    expect(first.telemetryGathering).not.toBe(second.telemetryGathering);
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
});
