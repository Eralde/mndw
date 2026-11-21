// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {OpkgError, type PackageEntry, type PackageInfo} from '../../services/opkg-client.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {createHostServices} from '../../host-services.js';
import {createTestLocaleController} from '../../testing/test-locale.js';
import {TestResizeObserver} from './test-resize-observer.js';

const {confirmHost} = vi.hoisted(() => ({confirmHost: vi.fn()}));

vi.mock('../../services/overlay/host-overlay.js', () => ({confirmHost}));

import PackagesPanel from './PackagesPanel.svelte';

const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
const opkgClient = services.opkgClient;
const {context, setLocale} = createTestLocaleController(services);

const referenceTime = new Date('2026-11-16T12:00:00.000Z');

beforeEach(() => {
  TestResizeObserver.reset();
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });

  return {
    promise,
    resolve(value) {
      complete?.(value);
    },
  };
}

function findButton(label: string): (HTMLElement & {disabled: boolean}) | undefined {
  return [...document.querySelectorAll<HTMLElement & {disabled: boolean}>('mndw-button')]
    .find((button) => button.textContent?.trim() === label);
}

function showAllPackagesTab(host: HTMLElement): void {
  host.querySelector('mndw-tabs')?.dispatchEvent(
    new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'all'}}),
  );
  flushSync();
}

describe('PackagesPanel metadata age', () => {
  let host: HTMLElement;

  beforeAll(() => {
    defineMndwUi();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    host.remove();
    document.body.innerHTML = '';
    await setLocale('en');
  });

  it.each([
    {locale: 'en', ageMs: 0, expected: 'Package list updated just now'},
    {locale: 'en', ageMs: 5 * 60_000, expected: 'Package list updated 5 minutes ago'},
    {locale: 'en', ageMs: 3 * 60 * 60_000, expected: 'Package list updated 3 hours ago'},
    {locale: 'en', ageMs: 3 * 24 * 60 * 60_000, expected: 'Package list updated 3 days ago'},
    {locale: 'ru', ageMs: 0, expected: 'Список пакетов обновлён только что'},
    {locale: 'ru', ageMs: 5 * 60_000, expected: 'Список пакетов обновлён 5 минут назад'},
    {locale: 'ru', ageMs: 3 * 60 * 60_000, expected: 'Список пакетов обновлён 3 часа назад'},
    {locale: 'ru', ageMs: 3 * 24 * 60 * 60_000, expected: 'Список пакетов обновлён 3 дня назад'},
  ])('formats metadata age in $locale at $ageMs ms', async ({locale, ageMs, expected}) => {
    await setLocale(locale);

    const metadataUpdatedAt = new Date(referenceTime.getTime() - ageMs).toISOString();

    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [],
      metadataUpdatedAt,
    });
    host = document.createElement('div');
    document.body.appendChild(host);

    const component = mount(PackagesPanel, {
      target: host,
      context,
      props: {now: () => new Date(referenceTime)},
    });

    try {
      flushSync();
      await vi.waitFor(() => {
        flushSync();
        expect(host.querySelector('.freshness')?.textContent?.trim()).toBe(expected);
      });
    } finally {
      await unmount(component);
    }
  });
});

describe('PackagesPanel controls', () => {
  let host: HTMLElement;
  let component: ReturnType<typeof mount> | undefined;

  beforeAll(() => {
    defineMndwUi();
  });

  beforeEach(() => {
    toast.clear();
  });

  afterEach(async () => {
    if (component !== undefined) {
      await unmount(component);
      component = undefined;
    }

    confirmHost.mockReset();
    toast.clear();
    vi.restoreAllMocks();
    host?.remove();
    document.body.innerHTML = '';
    await setLocale('en');
  });

  function renderPanel(): void {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(PackagesPanel, {
      target: host,
      context,
      props: {now: () => new Date(referenceTime)},
    });
    flushSync();
  }

  it('renders status and filter rows with an accessible search name and no Update all action', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'update_available'}],
      metadataUpdatedAt: null,
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const statusRow = host.querySelector('.status-row');
    const filterRow = host.querySelector('.filter-row');
    const tabs = filterRow?.querySelector('mndw-tabs');
    const freshness = statusRow?.querySelector('.freshness');
    const refresh = findButton('Check for updates');
    const searchField = host.querySelector<HTMLElement & {label: string; updateComplete: Promise<unknown>}>(
      '.filter-row mndw-field',
    );
    const search = host.querySelector<HTMLElement & {updateComplete: Promise<unknown>}>(
      '.filter-row mndw-input[type="search"]',
    );
    const packagePanel = host.querySelector('.packages-panel');

    if (statusRow === null || filterRow === null || packagePanel === null) {
      throw new Error('Expected package toolbar rows');
    }

    const packagePanelRows = [...packagePanel.children];

    expect(statusRow?.firstElementChild).toBe(freshness);
    expect(statusRow?.classList.contains('mndw-alert')).toBe(true);
    expect(statusRow?.classList.contains('mndw-alert--warning')).toBe(true);
    expect(statusRow?.classList.contains('mndw-alert--info')).toBe(false);
    expect(statusRow?.getAttribute('role')).toBeNull();
    expect(freshness?.textContent?.trim()).toBe('The package list has not been updated yet');
    expect(freshness?.querySelector('mndw-icon')?.getAttribute('name')).toBe('circle-alert');
    expect(freshness?.querySelector('mndw-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(freshness?.nextElementSibling).toBe(refresh);
    expect(refresh?.parentElement).toBe(statusRow);
    expect(host.textContent).not.toContain('Reload');
    expect(filterRow?.firstElementChild).toBe(tabs);
    expect(tabs?.nextElementSibling).toBe(searchField);
    expect(packagePanelRows.indexOf(statusRow)).toBeLessThan(packagePanelRows.indexOf(filterRow));
    expect(findButton('Update all (1)')).toBeUndefined();
    expect(searchField).not.toBeNull();
    expect(search).not.toBeNull();
    await searchField?.updateComplete;
    expect(searchField?.label).toBe('Search name or description');
    expect(searchField?.querySelector('label')?.hidden).toBe(true);
    await search?.updateComplete;
    expect(search?.getAttribute('aria-label')).toBe('Search name or description');
    expect(search?.shadowRoot?.querySelector('input')?.getAttribute('aria-label'))
      .toBe('Search name or description');
  });

  it('shows a fresh list in an info alert with an info icon', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'installed'}],
      metadataUpdatedAt: referenceTime.toISOString(),
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const statusRow = host.querySelector('.status-row');

    expect(statusRow?.classList.contains('mndw-alert--info')).toBe(true);
    expect(statusRow?.classList.contains('mndw-alert--warning')).toBe(false);
    expect(statusRow?.querySelector('.freshness')?.textContent?.trim()).toBe('Package list updated just now');
    expect(statusRow?.querySelector('mndw-icon')?.getAttribute('name')).toBe('info');
    expect(statusRow?.querySelector('mndw-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('localizes the never-refreshed warning in Russian', async () => {
    await setLocale('ru');
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'installed'}],
      metadataUpdatedAt: null,
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    expect(host.querySelector('.status-row')?.classList.contains('mndw-alert--warning')).toBe(true);
    expect(host.querySelector('.freshness')?.textContent?.trim())
      .toBe('Список пакетов ещё не обновлялся');
  });

  it('shows a stale list in a warning alert with a warning icon', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'installed'}],
      metadataUpdatedAt: new Date(referenceTime.getTime() - 2 * 60 * 60_000).toISOString(),
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const statusRow = host.querySelector('.status-row');

    expect(statusRow?.classList.contains('mndw-alert--warning')).toBe(true);
    expect(statusRow?.classList.contains('mndw-alert--info')).toBe(false);
    expect(statusRow?.querySelector('mndw-icon')?.getAttribute('name')).toBe('circle-alert');
    expect(statusRow?.querySelector('mndw-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the selection row in place and switches between its hint and actions', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'installed'}],
      metadataUpdatedAt: null,
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const selectionRow = host.querySelector('.selection-row');
    const table = host.querySelector('mndw-table');

    expect(selectionRow).not.toBeNull();
    expect(selectionRow?.textContent).toContain('Select packages to install, update or remove them together');
    expect(selectionRow?.querySelector('mndw-button')).toBeNull();

    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['curl']},
      }),
    );
    flushSync();

    expect(host.querySelector('.selection-row')).toBe(selectionRow);
    expect(selectionRow?.textContent).toContain('Selected: 1');
    expect(selectionRow?.textContent).toContain('Remove (1)');
    expect(selectionRow?.textContent).toContain('Clear selection');
    expect(host.querySelector('mndw-table')).toBe(table);

    findButton('Clear selection')?.click();
    flushSync();

    expect(host.querySelector('.selection-row')).toBe(selectionRow);
    expect(selectionRow?.textContent).toContain('Select packages to install, update or remove them together');
    expect(host.querySelector('mndw-table')).toBe(table);
  });

  it('keeps the table mounted and exposes the busy row during a single action', async () => {
    const pkg: PackageEntry = {
      name: 'curl',
      version: '1',
      description: 'Command line transfer tool',
      status: 'update_available',
    };
    const operation = deferred<{message: string; packages: string[]}>();
    const list = vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [pkg],
      metadataUpdatedAt: null,
    });
    const upgrade = vi.spyOn(opkgClient, 'upgrade').mockReturnValue(operation.promise);

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const table = host.querySelector('mndw-table') as
      | (HTMLElement & {
        rows: Array<PackageEntry & {busyAction?: string; actionsDisabled: boolean}>;
        scrollToRow: (key: string, options?: {align?: 'start' | 'center' | 'end' | 'nearest'}) => boolean;
      })
      | null;

    if (table === null) {
      throw new Error('Expected package table');
    }

    await vi.waitFor(() => expect(table.rows).toHaveLength(1));

    const scrollToRow = vi.spyOn(table, 'scrollToRow');
    const update = findButton('Update');

    update?.click();

    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledWith(['curl']));
    flushSync();

    expect(host.querySelector('mndw-table')).toBe(table);
    expect(table?.rows[0]?.busyAction).toBe('upgrade');
    await vi.waitFor(() => {
      expect(host.querySelector('[slot^="mc-"] [role="status"]')?.textContent).toContain('Updating…');
    });
    operation.resolve({message: 'Updated', packages: ['curl']});
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(table?.rows[0]?.busyAction).toBeUndefined());
    expect(scrollToRow).not.toHaveBeenCalled();
    expect(toast.toasts.map((item) => item.message)).not.toContain('1 packages loaded');
  });

  it('keeps the table mounted and marks selected rows busy during a bulk action', async () => {
    const pkg: PackageEntry = {name: 'curl', version: '1', description: '', status: 'available'};
    const otherPkg: PackageEntry = {name: 'vim', version: '1', description: '', status: 'installed'};
    const operation = deferred<{message: string; packages: string[]}>();
    const list = vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [pkg, otherPkg],
      metadataUpdatedAt: null,
    });
    const install = vi.spyOn(opkgClient, 'install').mockReturnValue(operation.promise);

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    showAllPackagesTab(host);

    const table = host.querySelector('mndw-table') as
      | (HTMLElement & {
        rows: Array<PackageEntry & {busyAction?: string; actionsDisabled: boolean}>;
      })
      | null;

    table?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['curl']},
      }),
    );
    flushSync();

    findButton('Install (1)')?.click();

    await vi.waitFor(() => expect(install).toHaveBeenCalledWith(['curl']));
    flushSync();

    expect(host.querySelector('mndw-table')).toBe(table);
    expect(table?.rows[0]?.busyAction).toBe('install');
    expect(table?.rows[1]?.actionsDisabled).toBe(true);
    expect(findButton('Install (1)')?.disabled).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.querySelector<HTMLElement & {disabled: boolean}>('mndw-button[data-package="vim"]')?.disabled,
      ).toBe(true);
    });

    operation.resolve({message: 'Installed', packages: ['curl']});
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(host.querySelector('.selection-row .selection-hint')).not.toBeNull();
    });
  });

  it('disables expanded-row remove actions while another package action runs', async () => {
    const installable: PackageEntry = {
      name: 'curl',
      version: '1',
      description: '',
      status: 'available',
    };
    const updatable: PackageEntry = {
      name: 'vim',
      version: '1',
      description: '',
      status: 'update_available',
    };
    const operation = deferred<{message: string; packages: string[]}>();

    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [installable, updatable],
      metadataUpdatedAt: null,
    });

    vi.spyOn(opkgClient, 'info').mockResolvedValue({...updatable, dependencies: []});

    const install = vi.spyOn(opkgClient, 'install').mockReturnValue(operation.promise);

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    showAllPackagesTab(host);
    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwrowexpand', {
        bubbles: true,
        detail: {expanded: ['vim']},
      }),
    );
    await vi.waitFor(() => expect(host.querySelector('mndw-button[data-package-action="detail"]')).not.toBeNull());
    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['curl']},
      }),
    );
    flushSync();

    findButton('Install (1)')?.click();

    await vi.waitFor(() => expect(install).toHaveBeenCalledWith(['curl']));
    await vi.waitFor(() => {
      expect(
        host.querySelector<HTMLElement & {disabled: boolean}>(
          'mndw-button[data-package-action="detail"]',
        )?.disabled,
      ).toBe(true);
    });

    operation.resolve({message: 'Installed', packages: ['curl']});
    await vi.waitFor(() =>
      expect(
        host.querySelector<HTMLElement & {disabled: boolean}>(
          'mndw-button[data-package-action="detail"]',
        )?.disabled,
      ).toBe(false)
    );
  });

  it('keeps the table mounted while checking for updates', async () => {
    const pkg: PackageEntry = {name: 'curl', version: '1', description: '', status: 'installed'};
    const operation = deferred<{message: string}>();
    const list = vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [pkg],
      metadataUpdatedAt: null,
    });
    const update = vi.spyOn(opkgClient, 'update').mockReturnValue(operation.promise);

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const table = host.querySelector('mndw-table');

    findButton('Check for updates')?.click();

    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    flushSync();

    expect(host.querySelector('mndw-table')).toBe(table);
    expect(findButton('Checking…')?.disabled).toBe(true);

    operation.resolve({message: 'Metadata refreshed'});
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(host.querySelector('mndw-table')).toBe(table);
  });

  it('matches package descriptions in the search field', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [
        {name: 'curl', version: '1', description: 'Command line transfer tool', status: 'installed'},
        {name: 'git', version: '2', description: 'Version control system', status: 'installed'},
      ],
      metadataUpdatedAt: null,
    });

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    host.querySelector('mndw-input[type="search"]')?.dispatchEvent(
      new CustomEvent('mndwinput', {bubbles: true, detail: {value: 'TRANSFER TOOL'}}),
    );
    flushSync();

    const table = host.querySelector('mndw-table') as (HTMLElement & {rows: PackageEntry[]}) | null;

    expect(table).not.toBeNull();
    expect(table?.rows.map((pkg) => pkg.name)).toEqual(['curl']);
  });

  it('excludes mndw from bulk Update but includes lighttpd', async () => {
    const list = vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [
        {name: 'updatable', version: '1', description: '', status: 'update_available'},
        {name: 'mndw', version: '1', description: '', status: 'update_available'},
        {name: 'lighttpd', version: '1', description: '', status: 'update_available'},
      ],
      metadataUpdatedAt: null,
    });
    const upgrade = vi.spyOn(opkgClient, 'upgrade').mockResolvedValue({
      message: 'Updated',
      packages: ['updatable', 'lighttpd'],
    });

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    showAllPackagesTab(host);
    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['updatable', 'mndw', 'lighttpd']},
      }),
    );
    flushSync();

    expect(findButton('Update (2)')).toBeDefined();
    findButton('Update (2)')?.click();

    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledWith(['updatable', 'lighttpd']));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('reconciles a partially completed bulk action after rejection and clears selection', async () => {
    const initialPackages: PackageEntry[] = [
      {name: 'curl', version: '1', description: '', status: 'update_available'},
      {name: 'vim', version: '1', description: '', status: 'update_available'},
    ];
    const partialPackages: PackageEntry[] = [
      {name: 'curl', version: '1', description: '', status: 'installed'},
      {name: 'vim', version: '1', description: '', status: 'update_available'},
    ];
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: initialPackages, metadataUpdatedAt: null})
      .mockResolvedValueOnce({packages: partialPackages, metadataUpdatedAt: null});
    const upgrade = vi.spyOn(opkgClient, 'upgrade').mockRejectedValue(
      new OpkgError('Update stopped after partial completion', 'OPKG_FAILED'),
    );

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    showAllPackagesTab(host);
    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['curl', 'vim']},
      }),
    );
    flushSync();

    findButton('Update (2)')?.click();

    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledWith(['curl', 'vim']));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    const table = host.querySelector('mndw-table') as
      | (HTMLElement & {
        rows: Array<PackageEntry & {actionsDisabled: boolean}>;
      })
      | null;

    await vi.waitFor(() => {
      expect(table?.rows.map(({name, status}) => [name, status])).toEqual([
        ['curl', 'installed'],
        ['vim', 'update_available'],
      ]);
    });
    expect(toast.toasts.map(({message}) => message)).toContain('Update stopped after partial completion');
    expect(host.querySelector('.selection-row .selection-hint')).not.toBeNull();
    expect(table?.rows.every((row) => !row.actionsDisabled)).toBe(true);
    expect(findButton('Check for updates')?.disabled).toBe(false);
    expect(host.querySelector<HTMLElement & {disabled: boolean}>('mndw-button[data-package="vim"]')?.disabled)
      .toBe(false);
  });

  it('keeps rows and shows a retry alert when a successful mutation reload fails', async () => {
    const update: PackageEntry = {
      name: 'curl',
      version: '1',
      description: '',
      status: 'update_available',
    };
    const installed = {...update, version: '2', status: 'installed' as const};
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: [update], metadataUpdatedAt: null})
      .mockRejectedValueOnce(new OpkgError('Package list is temporarily unavailable', 'OPKG_FAILED'))
      .mockResolvedValueOnce({packages: [installed], metadataUpdatedAt: null});

    vi.spyOn(opkgClient, 'upgrade').mockResolvedValue({message: 'Updated curl', packages: ['curl']});

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const table = host.querySelector('mndw-table') as (HTMLElement & {rows: PackageEntry[]}) | null;

    findButton('Update')?.click();

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(host.querySelector('.package-load-error')?.textContent)
        .toContain('Package list is temporarily unavailable')
    );
    expect(host.querySelector('mndw-table')).toBe(table);
    expect(table?.rows[0]?.version).toBe('1');
    expect(toast.toasts.map(({message}) => message)).toContain('Updated curl');

    host.querySelector<HTMLElement>('.package-load-error mndw-button')?.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(host.querySelector('.package-load-error')).toBeNull());
    expect(table?.rows[0]?.version).toBe('2');
  });

  it('shows metadata success and stale-list alert when its follow-up reload fails', async () => {
    const pkg: PackageEntry = {name: 'curl', version: '1', description: '', status: 'installed'};
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: [pkg], metadataUpdatedAt: null})
      .mockRejectedValueOnce(new OpkgError('Package list is stale', 'OPKG_FAILED'));

    vi.spyOn(opkgClient, 'update').mockResolvedValue({message: 'Metadata refreshed'});

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const table = host.querySelector('mndw-table');

    findButton('Check for updates')?.click();

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(host.querySelector('.package-load-error')?.textContent)
        .toContain('Package list is stale')
    );
    expect(host.querySelector('mndw-table')).toBe(table);
    expect(toast.toasts.map(({message}) => message)).toContain('Metadata refreshed');
  });

  it('shows only applicable bulk actions with counts and clears selection', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [
        {name: 'installable', version: '1', description: '', status: 'available'},
        {name: 'updatable', version: '1', description: '', status: 'update_available'},
        {name: 'removable', version: '1', description: '', status: 'installed'},
        {name: 'mndw', version: '1', description: '', status: 'installed'},
      ],
      metadataUpdatedAt: null,
    });

    renderPanel();
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    showAllPackagesTab(host);
    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['installable', 'updatable', 'removable', 'mndw']},
      }),
    );
    flushSync();

    expect(findButton('Install (1)')).toBeDefined();
    expect(findButton('Update (1)')).toBeDefined();
    expect(findButton('Remove (2)')).toBeDefined();
    expect(findButton('Clear selection')).toBeDefined();
    expect(host.querySelector('.selection-row .selected-count')?.textContent).toContain('Selected: 4');
    expect([...host.querySelectorAll('.selection-row mndw-button')]).toHaveLength(4);

    findButton('Clear selection')?.click();
    flushSync();

    expect(host.querySelector('.selection-row .selection-hint')).not.toBeNull();
  });

  it.each([
    {error: new OpkgError('Package index is unavailable', 'OPKG_FAILED'), expected: 'Package index is unavailable'},
    {error: new Error('private failure detail'), expected: 'Failed to load packages'},
  ])('offers Retry and shows the selected load error', async ({error, expected}) => {
    const list = vi.spyOn(opkgClient, 'list')
      .mockRejectedValueOnce(error)
      .mockResolvedValue({packages: [], metadataUpdatedAt: null});

    renderPanel();

    await vi.waitFor(() => expect(host.textContent).toContain(expected));
    expect(host.textContent).not.toContain('private failure detail');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(toast.toasts).toHaveLength(0);

    const retry = [...host.querySelectorAll('mndw-button')].find((button) => {
      return button.textContent?.trim() === 'Retry';
    });

    expect(retry).toBeDefined();
    retry?.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.querySelector('.mndw-empty-state')).not.toBeNull());
  });

  it('shows an actionable empty state when no packages are installed', async () => {
    const list = vi.spyOn(opkgClient, 'list').mockResolvedValue({packages: [], metadataUpdatedAt: null});

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('.mndw-empty-state')).not.toBeNull());

    const emptyState = host.querySelector('.mndw-empty-state');

    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain('No packages found');

    const refresh = host.querySelector<HTMLElement>('.mndw-empty-state mndw-button');

    expect(refresh?.textContent?.trim()).toBe('Check for updates');
    refresh?.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('clears search and shows all packages from the no-match empty state', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'installed'}],
      metadataUpdatedAt: null,
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const search = host.querySelector<HTMLElement>('mndw-input[type="search"]');

    search?.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, detail: {value: 'missing'}}));
    flushSync();

    const emptyState = host.querySelector('.mndw-empty-state');

    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain('No packages match your filter');

    const showAll = emptyState?.querySelector<HTMLElement>('mndw-button');

    showAll?.focus();
    showAll?.click();
    flushSync();

    const table = host.querySelector('mndw-table') as (HTMLElement & {rows: PackageEntry[]}) | null;

    expect(table?.rows.map((pkg) => pkg.name)).toEqual(['curl']);
    await vi.waitFor(() => expect(document.activeElement).toBe(search));
  });

  it('returns focus to the package action after its row reloads', async () => {
    const update: PackageEntry = {
      name: 'curl',
      version: '1',
      description: '',
      status: 'update_available',
    };
    const installed = {...update, version: '2', status: 'installed' as const};
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: [update], metadataUpdatedAt: null})
      .mockResolvedValueOnce({packages: [installed], metadataUpdatedAt: null});
    const upgrade = vi.spyOn(opkgClient, 'upgrade').mockResolvedValue({message: 'Updated', packages: ['curl']});

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const updateButton = [...host.querySelectorAll('mndw-button')].find((button) => {
      return button.textContent?.trim() === 'Update';
    });

    expect(updateButton).toBeDefined();
    updateButton?.focus();
    expect(document.activeElement).toBe(updateButton);
    updateButton?.click();

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledWith(['curl']));
    await vi.waitFor(() => {
      const removeButton = [...host.querySelectorAll('mndw-button')].find((button) => {
        return button.textContent?.trim() === 'Remove';
      });

      expect(document.activeElement).toBe(removeButton);
    });
  });

  it('shows the Settings link instead of Update for mndw', async () => {
    const update: PackageEntry = {
      name: 'mndw',
      version: '1',
      description: '',
      status: 'update_available',
    };

    vi.spyOn(opkgClient, 'list').mockResolvedValue({packages: [update], metadataUpdatedAt: null});

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const settingsLink = host.querySelector<HTMLAnchorElement>('.settings-update-link');

    expect(settingsLink?.textContent?.trim()).toBe('Update in Settings');
    expect(settingsLink?.getAttribute('href')).toBe('/settings/self-update');
    expect(host.querySelector('mndw-button[data-package="mndw"]')).toBeNull();
  });

  it('focuses Check for updates when an action removes its package row', async () => {
    const update: PackageEntry = {
      name: 'curl',
      version: '1',
      description: '',
      status: 'update_available',
    };
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: [update], metadataUpdatedAt: null})
      .mockResolvedValueOnce({packages: [], metadataUpdatedAt: null});

    vi.spyOn(opkgClient, 'upgrade').mockResolvedValue({message: 'Updated', packages: ['curl']});

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const updateButton = [...host.querySelectorAll('mndw-button')].find((button) => {
      return button.textContent?.trim() === 'Update';
    });

    updateButton?.focus();
    updateButton?.click();

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const refreshButton = [...host.querySelectorAll('mndw-button')].find((button) => {
        return button.textContent?.trim() === 'Check for updates';
      });

      expect(document.activeElement).toBe(refreshButton);
    });
  });

  it('returns focus to expanded Remove after confirming and reloading its row', async () => {
    const update: PackageEntry = {
      name: 'curl',
      version: '1',
      description: '',
      status: 'update_available',
    };
    const info: PackageInfo = {...update, dependencies: []};
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: [update], metadataUpdatedAt: null})
      .mockResolvedValueOnce({packages: [update], metadataUpdatedAt: null});

    vi.spyOn(opkgClient, 'info').mockResolvedValue(info);
    vi.spyOn(opkgClient, 'remove').mockResolvedValue({message: 'Removed', packages: ['curl']});

    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;

    confirmHost.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirmation = resolve;
      }),
    );

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwrowexpand', {
        bubbles: true,
        detail: {expanded: ['curl']},
      }),
    );

    await vi.waitFor(() => expect(host.querySelector('.detail mndw-button')).not.toBeNull());

    const detailRemove = host.querySelector<HTMLElement>('.detail mndw-button');

    detailRemove?.focus();
    detailRemove?.click();

    await vi.waitFor(() => expect(confirmHost).toHaveBeenCalledOnce());
    resolveConfirmation?.(true);

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const refreshedRemove = host.querySelector<HTMLElement>('.detail mndw-button');

      expect(refreshedRemove).not.toBeNull();
      expect(document.activeElement).toBe(refreshedRemove);
    });
  });
});

const expectCompactMeta = async (host: HTMLElement): Promise<void> => {
  await vi.waitFor(() =>
    expect(host.querySelector('.package-compact-meta')?.textContent?.replaceAll('\u00a0', ' ')).toContain(
      '8.1 → 8.2 · Update available',
    )
  );
};

describe('PackagesPanel compact layout', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  it('switches package rows and columns at the panel-width breakpoint', async () => {
    await setLocale('en');
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{
        name: 'curl',
        version: '8.1',
        newVersion: '8.2',
        description: 'Command line transfer tool',
        status: 'update_available',
      }],
      metadataUpdatedAt: null,
    });

    const host = document.createElement('div');

    document.body.appendChild(host);

    const component = mount(PackagesPanel, {
      target: host,
      context,
      props: {now: () => new Date(referenceTime)},
    });

    try {
      flushSync();
      await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

      const table = host.querySelector('mndw-table') as
        | (HTMLElement & {
          columns: Array<{id: string; width?: string}>;
          hiddenColumns?: string[];
          rows: Array<PackageEntry & {compact: boolean}>;
        })
        | null;

      if (table === null) {
        throw new Error('Expected package table');
      }

      const panel = host.querySelector('.packages-panel');

      if (panel === null) {
        throw new Error('Expected package panel');
      }

      const observer = TestResizeObserver.observing(panel);

      observer.resize(360);
      flushSync();

      await vi.waitFor(() => expect(table.hiddenColumns).toEqual(['version', 'status']));
      expect(table.rows[0]?.compact).toBe(true);
      expect(table.columns.find((column) => column.id === 'name')?.width).toBe('8rem');
      await expectCompactMeta(host);

      observer.resize(640);
      flushSync();
      await vi.waitFor(() => expect(table.hiddenColumns).toEqual([]));
      expect(table.rows[0]?.compact).toBe(false);
      expect(table.columns.find((column) => column.id === 'name')?.width).toBe('11.25rem');
      await vi.waitFor(() => expect(host.querySelector('.package-compact-meta')).toBeNull());
    } finally {
      await unmount(component);
      host.remove();
      vi.restoreAllMocks();
    }
  });
});
