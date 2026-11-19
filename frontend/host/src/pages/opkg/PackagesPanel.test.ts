// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {OpkgError, type PackageEntry, type PackageInfo} from '../../services/opkg-client.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {createHostServices} from '../../host-services.js';
import {createTestLocaleController} from '../../testing/test-locale.js';

const {openHostModal} = vi.hoisted(() => ({openHostModal: vi.fn()}));

vi.mock('../../services/overlay/host-overlay.js', () => ({openHostModal}));

import PackagesPanel from './PackagesPanel.svelte';

const services = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
const opkgClient = services.opkgClient;
const {context, setLocale} = createTestLocaleController(services);

const referenceTime = new Date('2026-11-16T12:00:00.000Z');

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
    {locale: 'en', ageMs: 0, expected: 'Metadata refreshed just now'},
    {locale: 'en', ageMs: 5 * 60_000, expected: 'Metadata refreshed 5 minutes ago'},
    {locale: 'en', ageMs: 3 * 60 * 60_000, expected: 'Metadata refreshed 3 hours ago'},
    {locale: 'en', ageMs: 3 * 24 * 60 * 60_000, expected: 'Metadata refreshed 3 days ago'},
    {locale: 'ru', ageMs: 0, expected: 'Метаданные обновлены только что'},
    {locale: 'ru', ageMs: 5 * 60_000, expected: 'Метаданные обновлены 5 минут назад'},
    {locale: 'ru', ageMs: 3 * 60 * 60_000, expected: 'Метаданные обновлены 3 часа назад'},
    {locale: 'ru', ageMs: 3 * 24 * 60 * 60_000, expected: 'Метаданные обновлены 3 дня назад'},
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

    openHostModal.mockReset();
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

  it('uses one Check for updates action and a labelled UI search field', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({packages: [], metadataUpdatedAt: null});

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('.freshness')).not.toBeNull());

    const actions = [...host.querySelectorAll('.header-actions mndw-button')];
    const searchField = host.querySelector<HTMLElement & {label: string; updateComplete: Promise<unknown>}>(
      '.filter-row mndw-field',
    );
    const search = host.querySelector('mndw-input[type="search"]');

    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent?.trim()).toBe('Check for updates');
    expect(host.textContent).not.toContain('Reload');
    expect(searchField).not.toBeNull();
    await searchField?.updateComplete;
    expect(searchField?.label).toBe('Search packages');
    expect(search).not.toBeNull();
  });

  it('shows the bulk action bar only after a package is selected', async () => {
    vi.spyOn(opkgClient, 'list').mockResolvedValue({
      packages: [{name: 'curl', version: '1', description: '', status: 'installed'}],
      metadataUpdatedAt: null,
    });

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
    expect(host.querySelector('.bulk-bar')).toBeNull();

    host.querySelector('mndw-table')?.dispatchEvent(
      new CustomEvent('mndwselectionchange', {
        bubbles: true,
        detail: {selected: ['curl']},
      }),
    );
    flushSync();

    expect(host.querySelector('.bulk-bar')?.textContent).toContain('With selected:');
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

  it('focuses Check for updates when an updated protected package has no enabled row action', async () => {
    const update: PackageEntry = {
      name: 'lighttpd',
      version: '1',
      description: '',
      status: 'update_available',
    };
    const installed = {...update, version: '2', status: 'installed' as const};
    const list = vi.spyOn(opkgClient, 'list')
      .mockResolvedValueOnce({packages: [update], metadataUpdatedAt: null})
      .mockResolvedValueOnce({packages: [installed], metadataUpdatedAt: null});

    vi.spyOn(opkgClient, 'upgrade').mockResolvedValue({message: 'Updated', packages: ['lighttpd']});

    renderPanel();

    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());

    const updateButton = [...host.querySelectorAll('mndw-button')].find((button) => {
      return button.textContent?.trim() === 'Update';
    });

    expect(updateButton).toBeDefined();
    updateButton?.focus();
    updateButton?.click();

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const removeButton = host.querySelector<HTMLElement>('mndw-button[data-package="lighttpd"]');

      expect(removeButton).not.toBeNull();
      expect((removeButton as HTMLElement & {disabled: boolean}).disabled).toBe(true);
    });
    await vi.waitFor(() => {
      const refreshButton = host.querySelector<HTMLElement>('.header-actions mndw-button');

      expect(refreshButton).not.toBeNull();
      expect(document.activeElement).toBe(refreshButton);
    });
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

    let resolveConfirmation: ((event: {result: boolean}) => void) | undefined;

    openHostModal.mockReturnValue({
      closed: new Promise((resolve) => {
        resolveConfirmation = resolve;
      }),
    });

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

    await vi.waitFor(() => expect(openHostModal).toHaveBeenCalledOnce());
    resolveConfirmation?.({result: true});

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const refreshedRemove = host.querySelector<HTMLElement>('.detail mndw-button');

      expect(refreshedRemove).not.toBeNull();
      expect(document.activeElement).toBe(refreshedRemove);
    });
  });
});
