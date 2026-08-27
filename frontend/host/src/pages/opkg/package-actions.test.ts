import {flushSync} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import type {PackageEntry} from '../../services/opkg-client.js';
import {packageActionsRenderer} from './package-actions-renderer.svelte.js';

let host: HTMLElement;

beforeEach(() => {
  defineMndwUi();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('package actions cell', () => {
  it('renders a Remove button wired to onRemove, disabled for protected', () => {
    const onRemove = vi.fn();
    const renderer = packageActionsRenderer(onRemove)();
    const row: PackageEntry = {name: 'lighttpd', version: '1', description: '', status: 'installed'};

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const button = host.querySelector('mndw-button') as HTMLElement & {disabled: boolean};

    expect(button.disabled).toBe(true);
    renderer.destroy();
  });

  it('keeps remove callback bound to current row after an update', () => {
    const onRemove = vi.fn();
    const renderer = packageActionsRenderer(onRemove)();
    const first: PackageEntry = {name: 'first', version: '1', description: '', status: 'installed'};
    const second: PackageEntry = {name: 'second', version: '1', description: '', status: 'installed'};

    renderer.mount({node: host, row: first, value: undefined, colId: 'actions'});
    flushSync();
    renderer.update({node: host, row: second, value: undefined, colId: 'actions'});
    flushSync();
    (host.querySelector('mndw-button') as HTMLElement).click();

    expect(onRemove).toHaveBeenCalledWith('second');
    renderer.destroy();
  });
});
