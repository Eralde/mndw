// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {setLocale} from '../../services/locale.service.js';
import {type PackageEntry, type PackageInfo, opkgClient} from '../../services/opkg-client.js';

const {openHostModal} = vi.hoisted(() => ({openHostModal: vi.fn()}));

vi.mock('../../services/overlay/host-overlay.js', () => ({openHostModal}));

import PackagesPanel from './PackagesPanel.svelte';

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

  afterEach(async () => {
    if (component !== undefined) {
      await unmount(component);
      component = undefined;
    }

    openHostModal.mockReset();
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

  it('offers Retry after the package list fails to load', async () => {
    const list = vi.spyOn(opkgClient, 'list')
      .mockRejectedValueOnce(new Error('private failure detail'))
      .mockResolvedValue({packages: [], metadataUpdatedAt: null});

    renderPanel();

    await vi.waitFor(() => expect(host.textContent).toContain('Failed to load packages'));
    expect(host.textContent).not.toContain('private failure detail');

    const retry = [...host.querySelectorAll('mndw-button')].find((button) => {
      return button.textContent?.trim() === 'Retry';
    });

    expect(retry).toBeDefined();
    retry?.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.querySelector('mndw-table')).not.toBeNull());
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
