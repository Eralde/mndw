// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PackageEntry} from '../../services/opkg-client.js';
import {appState} from '../../state/app.svelte.js';
import PackageNameCell from './PackageNameCell.svelte';
import PackageStatusCell from './PackageStatusCell.svelte';
import PackageVersionCell from './PackageVersionCell.svelte';

let host: HTMLElement;

beforeEach(() => {
  appState.locale = 'en';
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('package cells', () => {
  it('shows the package description below its name with a full-text title', async () => {
    const row = {name: 'x', version: '1', description: 'A full package description',
      status: 'installed'} satisfies PackageEntry;
    const app = mount(PackageNameCell, {target: host, props: {row, value: row.name, colId: 'name'}});

    flushSync();

    const description = host.querySelector('.package-description');

    expect(description?.textContent).toBe('A full package description');
    expect(description?.getAttribute('title')).toBe('A full package description');
    expect(host.querySelector('.package-name')?.getAttribute('title')).toBe('x');
    await unmount(app);
  });

  it('omits the description line when the package description is empty', async () => {
    const row = {name: 'x', version: '1', description: '', status: 'installed'} satisfies PackageEntry;
    const app = mount(PackageNameCell, {target: host, props: {row, value: row.name, colId: 'name'}});

    flushSync();

    expect(host.querySelector('.package-description')).toBeNull();
    await unmount(app);
  });

  it('version cell truncates with a title and shows the new version', async () => {
    const row = {
      name: 'x',
      version: 'a-very-long-version-1234',
      description: '',
      status: 'update_available',
      newVersion: '2.0.0',
    } satisfies PackageEntry;
    const app = mount(PackageVersionCell, {target: host, props: {row, value: row.version, colId: 'version'}});

    flushSync();

    const value = host.querySelector('.ver-value');

    expect(value?.getAttribute('title')).toBe('a-very-long-version-1234');
    expect(host.textContent).toContain('2.0.0');
    await unmount(app);
  });

  it.each(
    [
      {locale: 'en', status: 'installed', label: 'Installed'},
      {locale: 'en', status: 'update_available', label: 'Update available'},
      {locale: 'en', status: 'available', label: 'Available'},
      {locale: 'ru', status: 'installed', label: 'Установлен'},
      {locale: 'ru', status: 'update_available', label: 'Есть обновление'},
      {locale: 'ru', status: 'available', label: 'Доступен'},
    ] as const,
  )('translates $status status in $locale', async ({locale, status, label}) => {
    appState.locale = locale;

    const row = {name: 'x', version: '1', description: '', status} satisfies PackageEntry;
    const app = mount(PackageStatusCell, {target: host, props: {row, value: row.status, colId: 'status'}});

    flushSync();

    expect(host.textContent?.trim()).toBe(label);
    await unmount(app);
  });
});
