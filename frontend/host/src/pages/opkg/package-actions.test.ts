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
});

describe('protected package actions', () => {
  it('shows a text protection label for mndw', () => {
    const onAction = vi.fn();
    const renderer = packageActionsRenderer(onAction)();
    const row: PackageEntry = {name: 'mndw', version: '1', description: '', status: 'installed'};

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const label = host.querySelector('.protected-label');

    expect(host.querySelector('mndw-button')).toBeNull();
    expect(label?.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('Protected');
    expect(label?.querySelector('.mndw-visually-hidden')?.textContent?.trim()).toBe('Protected package');
    expect(label?.getAttribute('title')).toBe('Protected package');
    expect(label?.getAttribute('aria-label')).toBeNull();
    renderer.destroy();
  });

  it('routes mndw updates through the Settings link', () => {
    const onUpdateInSettings = vi.fn();
    const renderer = packageActionsRenderer(vi.fn(), onUpdateInSettings)();
    const row: PackageEntry = {name: 'mndw', version: '1', description: '', status: 'update_available'};

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const link = host.querySelector<HTMLAnchorElement>('a');

    expect(host.querySelector('mndw-button')).toBeNull();
    expect(link?.textContent?.trim()).toBe('Update in Settings');
    expect(link?.getAttribute('href')).toBe('/settings/self-update');
    link?.click();
    expect(onUpdateInSettings).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it('offers a normal Remove button for lighttpd', () => {
    const onAction = vi.fn();
    const renderer = packageActionsRenderer(onAction)();
    const row: PackageEntry = {name: 'lighttpd', version: '1', description: '', status: 'installed'};

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const button = host.querySelector('mndw-button');

    expect(button?.textContent?.trim()).toBe('Remove');
    button?.click();
    expect(onAction).toHaveBeenCalledWith('remove', 'lighttpd');
    renderer.destroy();
  });
});

describe('busy package actions', () => {
  it.each(
    [
      {status: 'available', busyAction: 'install', label: 'Installing…'},
      {status: 'installed', busyAction: 'remove', label: 'Removing…'},
      {status: 'update_available', busyAction: 'upgrade', label: 'Updating…'},
    ] as const,
  )('shows $label while $busyAction is in progress', ({status, busyAction, label}) => {
    const renderer = packageActionsRenderer(vi.fn())();
    const row = {name: 'curl', version: '1', description: '', status, busyAction} satisfies PackageEntry & {
      busyAction: 'install' | 'remove' | 'upgrade';
    };

    renderer.mount({node: host, row, value: undefined, colId: 'actions'});
    flushSync();

    const progress = host.querySelector('[role="status"]');

    expect(host.querySelector('mndw-button')).toBeNull();
    expect(progress?.textContent?.trim()).toBe(label);
    renderer.destroy();
  });
});

describe('package action row updates', () => {
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

  it('updates button disabled state from actionsDisabled when a virtual row is reused', () => {
    const renderer = packageActionsRenderer(vi.fn())();
    const busyRow = {
      name: 'curl',
      version: '1',
      description: '',
      status: 'installed',
      actionsDisabled: true,
    } satisfies PackageEntry & {actionsDisabled: boolean};

    renderer.mount({node: host, row: busyRow, value: undefined, colId: 'actions'});
    flushSync();

    const button = host.querySelector<HTMLElement & {disabled: boolean}>('mndw-button');

    expect(button?.disabled).toBe(true);

    renderer.update({node: host, row: {...busyRow, actionsDisabled: false}, value: undefined, colId: 'actions'});
    flushSync();

    expect(button?.disabled).toBe(false);
    renderer.destroy();
  });
});
