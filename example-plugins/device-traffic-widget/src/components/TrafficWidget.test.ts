// @vitest-environment happy-dom
import {flushSync, mount, settled, unmount} from 'svelte';
import type {RciManager, RciQuery} from '@rci-tools/core';
import type {PluginStorage} from '@mndw/sdk';
import {afterEach, describe, expect, it, vi} from 'vitest';
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
      },
    });
    await flush();

    await vi.waitFor(() => expect(host.querySelector('mndw-segmented')).not.toBeNull());

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
});
