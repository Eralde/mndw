// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {setLocale} from '../../services/locale.service.js';
import {opkgClient} from '../../services/opkg-client.js';
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
