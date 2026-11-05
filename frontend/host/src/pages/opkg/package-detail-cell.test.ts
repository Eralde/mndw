// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {SvelteMap} from 'svelte/reactivity';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PackageInfo} from '../../services/opkg-client.js';

import PackageDetailCell, {type PackageDetailState} from './PackageDetailCell.svelte';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('PackageDetailCell', () => {
  it('fetches info once on mount and renders extended fields', async () => {
    const info = {
      name: 'x',
      version: '1',
      description: 'Full desc',
      status: 'installed',
      size: '10k',
      installedSize: '20k',
      installedTime: 'yesterday',
      dependencies: ['libc'],
    } satisfies PackageInfo;
    const cache = new SvelteMap<string, PackageDetailState>();
    const load = vi.fn((name: string): void => {
      cache.set(name, {status: 'success', info});
    });

    const row = {name: 'x', version: '1', description: 'Full desc', status: 'installed'} as const;
    const app = mount(PackageDetailCell, {
      target: host,
      props: {
        row,
        value: row,
        colId: '__mndw_detail__',
        cache,
        load,
        retry: vi.fn(),
      },
    });

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Full desc');
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('libc');
    await unmount(app);
  });
});
