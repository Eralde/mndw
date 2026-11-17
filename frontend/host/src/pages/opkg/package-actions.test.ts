// @vitest-environment happy-dom
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
  it.each(
    [
      {status: 'available', label: 'Install', action: 'install', variant: 'primary'},
      {status: 'update_available', label: 'Update', action: 'upgrade', variant: 'primary'},
      {status: 'installed', label: 'Remove', action: 'remove', variant: 'secondary'},
    ] as const,
  )(
    'renders $label for $status packages and sends the matching action',
    ({status, label, action, variant}) => {
      const onAction = vi.fn();
      const renderer = packageActionsRenderer(onAction)();
      const row: PackageEntry = {name: 'curl', version: '1', description: '', status};

      renderer.mount({node: host, row, value: undefined, colId: 'actions'});
      flushSync();

      const button = host.querySelector('mndw-button') as HTMLElement & {disabled: boolean; variant: string};

      expect(button.textContent?.trim()).toBe(label);
      expect(button.variant).toBe(variant);
      expect(button.disabled).toBe(false);
      button.click();
      expect(onAction).toHaveBeenCalledWith(action, 'curl');
      renderer.destroy();
    },
  );

  it('keeps protected packages from being removed', () => {
    const onAction = vi.fn();
    const renderer = packageActionsRenderer(onAction)();
    const row: PackageEntry = {name: 'lighttpd', version: '1', description: '', status: 'installed'};

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const button = host.querySelector('mndw-button') as HTMLElement & {disabled: boolean};

    expect(button.textContent?.trim()).toBe('Remove');
    expect(button.disabled).toBe(true);
    renderer.destroy();
  });

  it('keeps action and name bound to current row after an update', () => {
    const onAction = vi.fn();
    const renderer = packageActionsRenderer(onAction)();
    const first: PackageEntry = {name: 'first', version: '1', description: '', status: 'installed'};
    const second: PackageEntry = {name: 'second', version: '1', description: '', status: 'update_available'};

    renderer.mount({node: host, row: first, value: undefined, colId: 'actions'});
    flushSync();
    renderer.update({node: host, row: second, value: undefined, colId: 'actions'});
    flushSync();

    const button = host.querySelector('mndw-button') as HTMLElement;

    expect(button.textContent?.trim()).toBe('Update');
    button.click();
    expect(onAction).toHaveBeenCalledWith('upgrade', 'second');
    renderer.destroy();
  });
});
