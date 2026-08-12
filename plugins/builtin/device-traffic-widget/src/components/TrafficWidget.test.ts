// @vitest-environment happy-dom
import {flushSync, mount, settled, unmount} from 'svelte';
import type {RciManager, RciQuery} from '@rci-tools/core';
import type {PluginStorage} from '@mndw/sdk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../../i18n/en.json';
import {of} from 'rxjs';
import TrafficWidget from './TrafficWidget.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

function storageWithSelectedDevice(): PluginStorage & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn((key: string) => Promise.resolve(key === 'selected-mac' ? 'AA' : '2')),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn().mockResolvedValue([]),
  } as unknown as PluginStorage & {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

function fakeRci(queue: ReturnType<typeof vi.fn>): RciManager {
  return {queue} as unknown as RciManager;
}

async function flush(): Promise<void> {
  await settled();
  flushSync();
  await Promise.resolve();
  await settled();
  flushSync();
}

afterEach(() => {
  if (app !== null) {
    void unmount(app);
    app = null;
  }

  host?.remove();
});

describe('TrafficWidget shared controls', () => {
  it('uses segmented controls and button for detail and settings actions', async () => {
    const queue = vi.fn((query: RciQuery) => {
      if (query.path === 'show.ip.hotspot') {
        return of({host: [{mac: 'AA', name: 'Router', hostname: 'router', active: true}]});
      }

      if (query.path === 'show.clock.date') {
        return of({year: 2026, month: 8, day: 1, hour: 12, min: 0, sec: 0, msec: 0});
      }

      if (query.path === 'show.ip.hotspot.chart') {
        const attribute = (query.data as {attributes?: string} | undefined)?.attributes;

        return of({bar: [{
          mac: 'AA',
          bars: [{
            attribute,
            data: attribute === 'sumspeed'
              ? [{t: 10, v: 100}, {t: 20, v: 200}]
              : attribute === 'txspeed'
              ? [{t: 10, v: 300}]
              : [{t: 10, v: 150}],
          }],
        }]});
      }

      return of({bar: []});
    });
    const storage = storageWithSelectedDevice();
    const openSettings = vi.fn();

    host = document.createElement('div');
    document.body.append(host);
    app = mount(TrafficWidget, {
      target: host,
      props: {
        rci: fakeRci(queue),
        storage,
        openSettings,
        i18n: createTestI18n(enCatalog),
      },
    });
    await flush();

    await vi.waitFor(() => expect(host.querySelector('mndw-segmented')).not.toBeNull());

    const chart = host.querySelector('mndw-bar-chart') as
      | (HTMLElement & {
        points?: Array<{time: number; value: number}>;
        valueLabel?: string;
      })
      | null;

    expect(chart).not.toBeNull();
    expect(chart?.points?.map((point) => point.value)).toEqual([100, 200]);
    expect(chart?.getAttribute('aria-label')).toBe('Device traffic history');
    expect(chart?.valueLabel).toBe('Values');
    expect(host.querySelector('.traffic-summary')?.textContent).toContain('↓ 150 b/s ↑ 300 b/s');

    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.querySelectorAll('mndw-segment')).toHaveLength(4);
    expect(host.querySelector('mndw-button')).not.toBeNull();

    host.querySelector<HTMLElement>('mndw-button')?.click();
    expect(openSettings).toHaveBeenCalledOnce();

    const segmented = host.querySelector('mndw-segmented');

    if (segmented === null) {
      throw new Error('detail segmented control was not rendered');
    }

    segmented.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: '3'},
      }),
    );
    await flush();

    expect(storage.set).toHaveBeenCalledWith('detail', '3');
  });

  it('updates the mounted probe when locale changes', () => {
    const i18n = createTestI18n({l10n: {probe: 'Traffic English'}});
    const queue = vi.fn(() => of({host: []}));
    const storage = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue([]),
    } as unknown as PluginStorage;
    const openSettings = vi.fn();

    host = document.createElement('div');
    document.body.append(host);
    app = mount(TrafficWidget, {
      target: host,
      props: {rci: fakeRci(queue), storage, openSettings, i18n},
    });
    flushSync();

    const probe = host.querySelector<HTMLElement>('[data-testid="l10n-probe"]');
    expect(probe?.textContent).toBe('Traffic English');
    const enValue = probe?.textContent;
    i18n.setLocale('ru', {l10n: {probe: 'Трафик русский'}});
    flushSync();

    expect(enValue).not.toBe('Трафик русский');
    expect(host.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe('Трафик русский');
  });
});
