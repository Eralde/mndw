import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {type PackageEntry} from '../services/opkg-client.js';
import {setLocale} from '../services/locale.service.js';

const mockList = vi.fn<(...args: unknown[]) => Promise<PackageEntry[]>>();
const mockUpdate = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockInstall = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockRemove = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockUpgrade = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();

vi.mock('../services/opkg-client.js', () => ({
  OpkgError: Error,
  get opkgClient() {
    return {
      list: mockList,
      update: mockUpdate,
      install: mockInstall,
      remove: mockRemove,
      upgrade: mockUpgrade,
    };
  },
}));

import PackageManager from './opkg/PackageManager.svelte';

type MndwCheckboxHost = HTMLElement & {
  checked: boolean;
  indeterminate: boolean;
  updateComplete: Promise<unknown>;
};

describe('PackageManager', () => {
  let host: HTMLElement;

  beforeAll(() => {
    defineMndwUi();
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.clearAllMocks();
    host.remove();
  });

  it('shows an empty catalog as an informational state', async () => {
    mockList.mockResolvedValue([]);

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('No packages found');
    });

    expect(host.textContent).toContain('No packages found');
    await unmount(app);
  });

  it('updates package-manager labels after a locale commit', async () => {
    mockList.mockResolvedValue([]);

    const app = mount(PackageManager, {target: host});

    try {
      flushSync();
      await vi.waitFor(() => {
        flushSync();
        expect(host.textContent).toContain('No packages found');
      });

      await setLocale('ru');
      flushSync();

      expect(host.textContent).toContain('Пакеты не найдены');
      expect(host.textContent).toContain('Менеджер пакетов');
    } finally {
      await unmount(app);
      await setLocale('en');
    }
  });

  it('shows a load error for a rejected list', async () => {
    mockList.mockRejectedValue(new Error('offline'));

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Failed to load packages');
    });

    expect(host.textContent).toContain('Failed to load packages');
    await unmount(app);
  });

  it('preserves action feedback after reloading the list', async () => {
    mockList.mockResolvedValue([]);
    mockUpdate.mockResolvedValue({message: 'Package metadata refreshed'});

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('No packages found');
    });

    const refreshButton = [...host.querySelectorAll('mndw-button')].find((button) =>
      button.textContent?.trim() === 'Refresh Metadata'
    );

    refreshButton?.click();
    flushSync();
    await vi.waitFor(() => expect(host.textContent).toContain('Package metadata refreshed'));
    await unmount(app);
  });

  it('updates row selection, indeterminate select-all, and filter tabs through UI components', async () => {
    const packages = [
      {name: 'installed', version: '1.0.0', status: 'installed', description: 'Installed package'},
      {name: 'pending', version: '1.0.0', status: 'uninstalled', description: 'Pending package'},
      {name: 'update', version: '1.0.0', newVersion: '2.0.0', status: 'update_available',
        description: 'Update package'},
    ] satisfies PackageEntry[];

    mockList.mockResolvedValue(packages);

    const app = mount(PackageManager, {target: host});

    flushSync();

    await vi.waitFor(() => expect(host.textContent).toContain('Installed package'));

    const nameCell = host.querySelector('.col-name .package-name');

    expect(nameCell?.textContent).toBe('installed');
    expect(nameCell?.getAttribute('title')).toBe('installed');
    expect(host.querySelector('.badge-installed')?.textContent).toBe('installed');
    expect(host.querySelector('.badge-update_available')?.textContent).toBe('Update available');

    expect(host.querySelectorAll('mndw-checkbox')).toHaveLength(4);

    const checkboxes = [...host.querySelectorAll<MndwCheckboxHost>('mndw-checkbox')];
    const selectAll = checkboxes[0];
    const firstRow = checkboxes[1];

    firstRow?.click();
    await firstRow?.updateComplete;
    flushSync();

    expect(firstRow?.checked).toBe(true);
    expect(selectAll?.indeterminate).toBe(true);

    selectAll?.click();
    await selectAll?.updateComplete;
    flushSync();

    expect(checkboxes.slice(1).every((checkbox) => checkbox.checked)).toBe(true);

    const tabs = host.querySelector<HTMLElement & {value: string}>('mndw-tabs');

    tabs?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: 'updates'},
      }),
    );
    flushSync();

    expect(tabs?.value).toBe('updates');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.textContent).toContain('update');

    await unmount(app);
  });

  it('disables bulk actions when their selected package set is unavailable', async () => {
    const packages = [
      {name: 'installed', version: '1.0.0', status: 'installed', description: 'Installed package'},
    ] satisfies PackageEntry[];

    mockList.mockResolvedValue(packages);

    const app = mount(PackageManager, {target: host});

    flushSync();

    await vi.waitFor(() => expect(host.textContent).toContain('Installed package'));

    expect(host.querySelectorAll('mndw-checkbox')).toHaveLength(2);

    const actions = [...host.querySelectorAll<HTMLElement & {disabled: boolean}>('.bulk-bar mndw-button')];

    expect(actions.map((action) => action.disabled)).toEqual([true, true, true]);

    await unmount(app);
  });
});
