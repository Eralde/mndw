import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {type PackageEntry, type PackageList} from '../services/opkg-client.js';
import {setLocale} from '../services/locale.service.js';

const mockList = vi.fn<(...args: unknown[]) => Promise<PackageList>>();
const mockUpdate = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockInstall = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockRemove = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockUpgrade = vi.fn<(...args: unknown[]) => Promise<{message: string}>>();
const mockInfo = vi.hoisted(() => vi.fn());

vi.mock('../services/opkg-client.js', () => ({
  OpkgError: Error,
  get opkgClient() {
    return {
      list: mockList,
      info: mockInfo,
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

function tableRoot(host: HTMLElement): ShadowRoot {
  const table = host.querySelector('mndw-table');

  if (table?.shadowRoot === null || table?.shadowRoot === undefined) {
    throw new Error('expected package table shadow root');
  }

  return table.shadowRoot;
}

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
    mockList.mockResolvedValue({packages: [], metadataUpdatedAt: null});

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(tableRoot(host).textContent).toContain('No packages found');
    });

    expect(tableRoot(host).textContent).toContain('No packages found');
    await unmount(app);
  });

  it('updates package-manager labels after a locale commit', async () => {
    mockList.mockResolvedValue({packages: [], metadataUpdatedAt: null});

    const app = mount(PackageManager, {target: host});

    try {
      flushSync();
      await vi.waitFor(() => {
        flushSync();
        expect(tableRoot(host).textContent).toContain('No packages found');
      });

      await setLocale('ru');
      flushSync();
      await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;

      expect(tableRoot(host).textContent).toContain('Пакеты не найдены');
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
    mockList.mockResolvedValue({packages: [], metadataUpdatedAt: null});
    mockUpdate.mockResolvedValue({message: 'Package metadata refreshed'});

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(tableRoot(host).textContent).toContain('No packages found');
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
      {name: 'pending', version: '1.0.0', status: 'available', description: 'Pending package'},
      {name: 'update', version: '1.0.0', newVersion: '2.0.0', status: 'update_available',
        description: 'Update package'},
    ] satisfies PackageEntry[];

    mockList.mockResolvedValue({packages, metadataUpdatedAt: null});

    const app = mount(PackageManager, {target: host});

    flushSync();

    await vi.waitFor(() => expect(host.textContent).toContain('installed'));

    const filterTabs = host.querySelector<HTMLElement & {value: string}>('.filter-row mndw-tabs');

    filterTabs?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: 'all'},
      }),
    );
    flushSync();
    await vi.waitFor(() => expect(host.querySelector('.badge-available')).not.toBeNull());

    const nameCell = host.querySelector('.package-name');

    expect(nameCell?.textContent).toBe('installed');
    expect(nameCell?.getAttribute('title')).toBe('installed');
    expect(host.querySelector('.badge-installed')?.textContent).toBe('installed');
    expect(host.querySelector('.badge-update_available')?.textContent).toBe('Update available');
    expect(host.querySelector('.badge-available')?.textContent).toBe('Available');

    expect(tableRoot(host).querySelectorAll('mndw-checkbox')).toHaveLength(4);

    const checkboxes = [...tableRoot(host).querySelectorAll<MndwCheckboxHost>('mndw-checkbox')];
    const selectAll = checkboxes[0];
    const firstRow = checkboxes[1];

    firstRow?.click();
    await firstRow?.updateComplete;
    flushSync();
    await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;

    expect(firstRow?.checked).toBe(true);
    expect(selectAll?.indeterminate).toBe(true);

    selectAll?.click();
    await selectAll?.updateComplete;
    flushSync();
    await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;

    expect(checkboxes.slice(1).every((checkbox) => checkbox.checked)).toBe(true);

    const tabs = host.querySelector<HTMLElement & {value: string}>('.filter-row mndw-tabs');

    tabs?.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {value: 'updates'},
      }),
    );
    flushSync();
    await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;

    expect(tabs?.value).toBe('updates');
    expect(tableRoot(host).querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.textContent).toContain('update');

    await unmount(app);
  });

  it('disables bulk actions when their selected package set is unavailable', async () => {
    const packages = [
      {name: 'installed', version: '1.0.0', status: 'installed', description: 'Installed package'},
    ] satisfies PackageEntry[];

    mockList.mockResolvedValue({packages, metadataUpdatedAt: null});

    const app = mount(PackageManager, {target: host});

    flushSync();

    await vi.waitFor(() => expect(host.textContent).toContain('installed'));

    expect(tableRoot(host).querySelectorAll('mndw-checkbox')).toHaveLength(2);

    const actions = [...host.querySelectorAll<HTMLElement & {disabled: boolean}>('.bulk-bar mndw-button')];

    expect(actions.map((action) => action.disabled)).toEqual([true, true, true]);

    await unmount(app);
  });

  it('expands a row inline and does not refetch on re-sort or locale change', async () => {
    const packages = [
      {name: 'alpha', version: '1.0.0', status: 'installed', description: 'A'},
      {name: 'beta', version: '2.0.0', status: 'installed', description: 'B'},
    ] satisfies PackageEntry[];
    const info = {
      name: 'alpha',
      version: '1.0.0',
      description: 'Full A',
      status: 'installed',
      dependencies: [],
    } satisfies PackageEntry & {dependencies: string[]};

    mockList.mockResolvedValue({packages, metadataUpdatedAt: null});
    mockInfo.mockResolvedValue(info);

    const app = mount(PackageManager, {target: host});

    try {
      flushSync();
      await vi.waitFor(() => expect(host.textContent).toContain('alpha'));

      const dataCell = tableRoot(host).querySelector(
        '[part="row"][data-row-key="alpha"] [part~="cell"]:not([part~="select-cell"]):not([part~="expand-cell"])',
      );

      (dataCell as HTMLElement).click();
      await vi.waitFor(() => {
        flushSync();
        expect(host.textContent).toContain('Full A');
      });
      expect(mockInfo).toHaveBeenCalledTimes(1);

      const sortButton = tableRoot(host).querySelector<HTMLButtonElement>('button[data-sort-column="name"]');

      sortButton?.click();
      flushSync();
      await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
      expect(host.textContent).toContain('Full A');
      expect(mockInfo).toHaveBeenCalledTimes(1);

      await setLocale('ru');
      flushSync();
      await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
      expect(tableRoot(host).textContent).toContain('Пакет');
      expect(mockInfo).toHaveBeenCalledTimes(1);
    } finally {
      await unmount(app);
      await setLocale('en');
    }
  });

  it('places the expansion toggle beside the package name column', async () => {
    mockList.mockResolvedValue({
      packages: [{name: 'alpha', version: '1.0.0', status: 'installed', description: 'A'}],
      metadataUpdatedAt: null,
    });

    const app = mount(PackageManager, {target: host});

    try {
      flushSync();
      await vi.waitFor(() => expect(host.textContent).toContain('alpha'));

      const headers = [...tableRoot(host).querySelectorAll('[part~="header-cell"]')];

      expect(headers[0]?.getAttribute('part')).toContain('select-cell');
      expect(headers[1]?.textContent).toContain('Package');
      expect(headers[2]?.getAttribute('part')).toContain('expand-cell');
    } finally {
      await unmount(app);
    }
  });

  it('prunes expanded rows when a filter hides them', async () => {
    const packages = [
      {name: 'alpha', version: '1.0.0', status: 'installed', description: 'A'},
      {name: 'beta', version: '2.0.0', status: 'update_available', description: 'B'},
    ] satisfies PackageEntry[];

    mockList.mockResolvedValue({packages, metadataUpdatedAt: null});
    mockInfo.mockResolvedValue({
      name: 'alpha',
      version: '1.0.0',
      description: 'Full A',
      status: 'installed',
      dependencies: [],
    });

    const app = mount(PackageManager, {target: host});

    try {
      flushSync();
      await vi.waitFor(() => expect(host.textContent).toContain('alpha'));

      const table = host.querySelector('mndw-table') as HTMLElement & {
        rows: PackageEntry[];
        scrollToRow: (key: string, options?: {align?: 'start' | 'center' | 'end' | 'nearest'}) => boolean;
        updateComplete: Promise<unknown>;
      };

      await table.updateComplete;

      const scrollToRow = vi.spyOn(table, 'scrollToRow');

      scrollToRow.mockClear();

      const firstCell = tableRoot(host).querySelector('[part="row"][data-row-key="alpha"] [part~="cell"]');

      if (firstCell === null) {
        throw new Error('expected first package cell');
      }

      firstCell.dispatchEvent(new MouseEvent('click', {bubbles: true, composed: true}));
      await vi.waitFor(() => expect(host.textContent).toContain('Full A'));

      const tabs = host.querySelector<HTMLElement>('.filter-row mndw-tabs');

      tabs?.dispatchEvent(
        new CustomEvent('mndwchange', {
          bubbles: true,
          composed: true,
          detail: {value: 'updates'},
        }),
      );
      flushSync();
      expect(table.rows.map((row) => row.name)).toEqual(['beta']);
      expect(scrollToRow).not.toHaveBeenCalled();
      await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
      await vi.waitFor(() => expect(scrollToRow).toHaveBeenCalledWith('beta', {align: 'start'}));
      expect(tableRoot(host).querySelector('[part="detail-row"]')).toBeNull();
      expect(mockInfo).toHaveBeenCalledTimes(1);

      tabs?.dispatchEvent(
        new CustomEvent('mndwchange', {
          bubbles: true,
          composed: true,
          detail: {value: 'installed'},
        }),
      );
      flushSync();
      await (host.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>}).updateComplete;
      expect(tableRoot(host).querySelector('[part="detail-row"]')).toBeNull();
      expect(mockInfo).toHaveBeenCalledTimes(1);
    } finally {
      await unmount(app);
    }
  });
});
