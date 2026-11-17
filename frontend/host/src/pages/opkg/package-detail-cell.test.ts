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
        onRemove: vi.fn(),
      },
    });

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Full desc');
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('libc');
    expect(host.querySelector('mndw-button')).toBeNull();
    await unmount(app);
  });

  it('shows a secondary Remove action for an update in expanded details', async () => {
    const row = {name: 'x', version: '1', description: 'Summary', status: 'update_available'} as const;
    const cache = new SvelteMap<string, PackageDetailState>();

    cache.set('x', {
      status: 'success',
      info: {...row, dependencies: []},
    });

    const onRemove = vi.fn();
    const app = mount(PackageDetailCell, {
      target: host,
      props: {
        row,
        value: row,
        colId: '__mndw_detail__',
        cache,
        load: vi.fn(),
        retry: vi.fn(),
        onRemove,
      },
    });

    flushSync();

    const button = host.querySelector('mndw-button');

    expect(button?.textContent?.trim()).toBe('Remove');
    expect(button?.getAttribute('variant')).toBe('secondary');
    button?.click();
    expect(onRemove).toHaveBeenCalledOnce();
    await unmount(app);
  });

  it('keeps Remove available when update details fail to load', async () => {
    const row = {name: 'x', version: '1', description: 'Summary', status: 'update_available'} as const;
    const cache = new SvelteMap<string, PackageDetailState>();

    cache.set('x', {status: 'failure', message: 'Details unavailable'});

    const onRemove = vi.fn();
    const retry = vi.fn();
    const app = mount(PackageDetailCell, {
      target: host,
      props: {
        row,
        value: row,
        colId: '__mndw_detail__',
        cache,
        load: vi.fn(),
        retry,
        onRemove,
      },
    });

    flushSync();

    const buttons = [...host.querySelectorAll('mndw-button')];
    const removeButton = buttons.find((button) => button.textContent?.trim() === 'Remove');
    const retryButton = buttons.find((button) => button.textContent?.trim() === 'Retry');

    expect(host.textContent).toContain('Details unavailable');
    expect(retryButton).toBeDefined();
    expect(removeButton).toBeDefined();
    removeButton?.click();
    expect(onRemove).toHaveBeenCalledOnce();

    await unmount(app);
  });
});
