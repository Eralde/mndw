import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageStatusCell from './PackageStatusCell.svelte';
import PackageVersionCell from './PackageVersionCell.svelte';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('package cells', () => {
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

  it('status cell labels available as Available', async () => {
    const row = {name: 'x', version: '1', description: '', status: 'available'} satisfies PackageEntry;
    const app = mount(PackageStatusCell, {target: host, props: {row, value: row.status, colId: 'status'}});

    flushSync();

    expect(host.textContent).toContain('Available');
    await unmount(app);
  });
});
