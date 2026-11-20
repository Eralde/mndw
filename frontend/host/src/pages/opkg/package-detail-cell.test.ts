// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {SvelteMap} from 'svelte/reactivity';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PackageInfo} from '../../services/opkg-client.js';

import PackageDetailCell, {type PackageDetailState} from './PackageDetailCell.svelte';

let host: HTMLElement;

beforeEach(() => {
  defineMndwUi();
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
});

describe('PackageDetailCell remove action', () => {
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

    const button = host.querySelector<HTMLElement & {variant: string}>('mndw-button');

    expect(button?.textContent?.trim()).toBe('Remove');
    expect(button?.variant).toBe('secondary');
    button?.click();
    expect(onRemove).toHaveBeenCalledOnce();
    await unmount(app);
  });
});

describe('PackageDetailCell disabled actions', () => {
  it('disables the expanded-row Remove action from actionsDisabled', async () => {
    const row = {
      name: 'x',
      version: '1',
      description: 'Summary',
      status: 'update_available',
      busyAction: 'upgrade',
      actionsDisabled: true,
    } as const;
    const cache = new SvelteMap<string, PackageDetailState>();

    cache.set('x', {status: 'success', info: {...row, dependencies: []}});

    const app = mount(PackageDetailCell, {
      target: host,
      props: {
        row,
        value: row,
        colId: '__mndw_detail__',
        cache,
        load: vi.fn(),
        retry: vi.fn(),
        onRemove: vi.fn(),
      },
    });

    flushSync();

    const removeButton = host.querySelector<HTMLElement & {disabled: boolean}>(
      'mndw-button[data-package-action="detail"]',
    );

    expect(removeButton).not.toBeNull();
    expect(removeButton?.disabled).toBe(true);
    await unmount(app);
  });

  it('disables Retry while package actions are disabled', async () => {
    const row = {
      name: 'x',
      version: '1',
      description: 'Summary',
      status: 'update_available',
      actionsDisabled: true,
    } as const;
    const cache = new SvelteMap<string, PackageDetailState>();

    cache.set('x', {status: 'failure', message: 'Details unavailable'});

    const app = mount(PackageDetailCell, {
      target: host,
      props: {
        row,
        value: row,
        colId: '__mndw_detail__',
        cache,
        load: vi.fn(),
        retry: vi.fn(),
        onRemove: vi.fn(),
      },
    });

    flushSync();

    const buttons = [...host.querySelectorAll<HTMLElement & {disabled: boolean}>('mndw-button')];

    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await unmount(app);
  });
});

describe('PackageDetailCell failed details', () => {
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
