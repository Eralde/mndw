import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {clearPluginVersionWarnings, setPluginVersionWarnings} from '../../../runtime/plugin-version-warnings.svelte.js';
import {replaceDepsStatuses} from '../../../state/deps-status.svelte.js';
import InstalledPluginList from './InstalledPluginList.svelte';

const emptyBackend = {routes: {}};

function plugin(over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    type: 'widget',
    name: 'network-tools',
    version: '1.0.0',
    label: 'Network Tools',
    entry: 'index.js',
    source: 'upload',
    approval: 'approved',
    enabled: true,
    size: {w: 4, h: 3},
    backend: emptyBackend,
    ...over,
  } as PluginListEntry;
}

function mountInstalledPluginList(props: Partial<{
  items: PluginListEntry[];
  busyName: string | null;
  confirmingName: string | null;
  actionError: {name: string; message: string} | null;
  permissionVisible: boolean;
  permissionAvailable: boolean;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onPermissionChange: (name: string, permission: 'persistent-rci-session', enabled: boolean) => void;
  onDelete: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
}> = {}): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(InstalledPluginList, {
    target,
    props: {
      items: [plugin()],
      busyName: null,
      confirmingName: null,
      actionError: null,
      permissionVisible: false,
      permissionAvailable: false,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
      onPermissionChange: vi.fn(),
      onDelete: vi.fn(),
      onRequestConfirm: vi.fn(),
      onCancelConfirm: vi.fn(),
      ...props,
    },
  });

  flushSync();

  return {component, target};
}

describe('InstalledPluginList', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  afterEach(() => {
    clearPluginVersionWarnings();
    replaceDepsStatuses([]);
    document.body.innerHTML = '';
  });

  it('renders empty state when no plugins are installed', () => {
    const {component, target} = mountInstalledPluginList({items: []});

    expect(target.textContent).toContain('Installed plugins');
    expect(target.querySelector('.mndw-installed__empty')?.textContent).toBe('No plugins installed.');

    void unmount(component);
  });

  it('disables an enabled user plugin', () => {
    const onDisable = vi.fn();
    const {component, target} = mountInstalledPluginList({onDisable});

    expect(target.textContent).toContain('Network Tools');
    expect(target.textContent).toContain('1.0.0');
    expect(target.textContent).toContain('widget');
    expect(target.textContent).toContain('upload');

    target.querySelector<HTMLButtonElement>('.mndw-installed__toggle')?.click();

    expect(onDisable).toHaveBeenCalledWith('network-tools');

    void unmount(component);
  });

  it('deletes only after parent supplies matching confirmation state', () => {
    const onDelete = vi.fn();
    const onCancelConfirm = vi.fn();
    const {component, target} = mountInstalledPluginList({
      confirmingName: 'network-tools',
      onDelete,
      onCancelConfirm,
    });

    expect(target.querySelector('.mndw-installed__confirm')).not.toBeNull();
    target.querySelector<HTMLButtonElement>('.mndw-installed__confirm')?.click();
    expect(onDelete).toHaveBeenCalledWith('network-tools');

    target.querySelector<HTMLButtonElement>('.mndw-installed__cancel')?.click();
    expect(onCancelConfirm).toHaveBeenCalledOnce();

    void unmount(component);
  });

  it('retains toggle while parent supplies matching confirmation state', () => {
    const {component, target} = mountInstalledPluginList({confirmingName: 'network-tools'});

    expect(target.querySelector('.mndw-installed__toggle')).not.toBeNull();

    void unmount(component);
  });

  it('disables cancellation while an action is busy', () => {
    const {component, target} = mountInstalledPluginList({
      busyName: 'network-tools',
      confirmingName: 'network-tools',
    });

    expect(target.querySelector<HTMLButtonElement>('.mndw-installed__cancel')?.disabled).toBe(true);

    void unmount(component);
  });

  it('renders builtin plugin badge without user controls', () => {
    const {component, target} = mountInstalledPluginList({
      items: [plugin({source: 'builtin'})],
    });

    expect(target.querySelector('.mndw-installed__builtin')?.textContent).toContain('Built-in');
    expect(target.querySelector('.mndw-installed__toggle')).toBeNull();
    expect(target.querySelector('.mndw-installed__delete')).toBeNull();

    void unmount(component);
  });

  it('hides permission switch when capability is hidden or permission is undeclared', () => {
    const hidden = mountInstalledPluginList({
      permissionVisible: false,
      items: [plugin({permissions: ['persistent-rci-session']})],
    });

    expect(hidden.target.querySelector('.mndw-installed__permission-switch')).toBeNull();
    void unmount(hidden.component);

    const undeclared = mountInstalledPluginList({permissionVisible: true});

    expect(undeclared.target.querySelector('.mndw-installed__permission-switch')).toBeNull();
    void unmount(undeclared.component);
  });

  it('renders an off permission switch and reports an optimistic enable', () => {
    const onPermissionChange = vi.fn();
    const {component, target} = mountInstalledPluginList({
      permissionVisible: true,
      permissionAvailable: true,
      onPermissionChange,
      items: [plugin({permissions: ['persistent-rci-session']})],
    });
    const control = target.querySelector<HTMLElement & {checked: boolean; disabled: boolean}>(
      '.mndw-installed__permission-switch mndw-switch',
    );

    expect(control?.checked).toBe(false);
    expect(control?.disabled).toBe(false);
    control?.click();
    expect(onPermissionChange).toHaveBeenCalledWith('network-tools', 'persistent-rci-session', true);

    void unmount(component);
  });

  it('disables only off permission switches when controller capability is unavailable', () => {
    const off = mountInstalledPluginList({
      permissionVisible: true,
      permissionAvailable: false,
      items: [plugin({permissions: ['persistent-rci-session']})],
    });
    const offControl = off.target.querySelector<HTMLElement & {disabled: boolean}>(
      '.mndw-installed__permission-switch mndw-switch',
    );

    expect(offControl?.disabled).toBe(true);
    void unmount(off.component);

    const checked = mountInstalledPluginList({
      permissionVisible: true,
      permissionAvailable: false,
      items: [plugin({permissions: ['persistent-rci-session'], permissionGrants: {'persistent-rci-session': true}})],
    });
    const checkedControl = checked.target.querySelector<HTMLElement & {disabled: boolean}>(
      '.mndw-installed__permission-switch mndw-switch',
    );

    expect(checkedControl?.disabled).toBe(false);
    void unmount(checked.component);
  });

  it('renders permission control for builtins without lifecycle controls', () => {
    const {component, target} = mountInstalledPluginList({
      permissionVisible: true,
      permissionAvailable: true,
      items: [plugin({source: 'builtin', permissions: ['persistent-rci-session']})],
    });

    expect(target.querySelector('.mndw-installed__permission-switch')).not.toBeNull();
    expect(target.querySelector('.mndw-installed__toggle')).toBeNull();
    expect(target.querySelector('.mndw-installed__delete')).toBeNull();

    void unmount(component);
  });

  it('disables permission switch while another action is busy', () => {
    const {component, target} = mountInstalledPluginList({
      permissionVisible: true,
      permissionAvailable: true,
      busyName: 'network-tools',
      items: [plugin({permissions: ['persistent-rci-session']})],
    });
    const control = target.querySelector<HTMLElement & {disabled: boolean}>(
      '.mndw-installed__permission-switch mndw-switch',
    );

    expect(control?.disabled).toBe(true);

    void unmount(component);
  });

  it('summarizes backend capabilities', () => {
    const {component, target} = mountInstalledPluginList({
      items: [plugin({
        backend: {
          routes: {
            status: {transport: 'http', method: 'GET', path: 'status'},
            events: {transport: 'websocket', path: 'events'},
          },
        },
      })],
    });

    expect(target.textContent).toContain('1 endpoint');
    expect(target.textContent).toContain('1 websocket');

    void unmount(component);
  });

  it('renders a persistent version mismatch badge on the matching plugin row', () => {
    setPluginVersionWarnings('network-tools', ['rxjs @6 (host provides @7)']);

    const {component, target} = mountInstalledPluginList();

    expect(target.querySelector('.mndw-installed__version-badge')?.textContent).toContain('Version mismatch');
    expect(target.querySelector('.mndw-installed__version-warning')?.textContent).toContain('rxjs @6');

    void unmount(component);
  });

  it('renders dependency badges from the shared status store', () => {
    replaceDepsStatuses([{name: 'network-tools', depsStatus: 'installing'}]);

    const installing = mountInstalledPluginList({items: [plugin({depsStatus: 'ready'})]});

    expect(installing.target.querySelector('.mndw-installed__deps-badge')?.textContent)
      .toContain('Installing dependencies…');
    void unmount(installing.component);

    replaceDepsStatuses([{name: 'network-tools', depsStatus: 'failed'}]);

    const failed = mountInstalledPluginList({items: [plugin({depsStatus: 'ready'})]});

    expect(failed.target.querySelector('.mndw-installed__deps-badge--failed')?.textContent)
      .toContain('Dependency install failed');
    void unmount(failed.component);
  });

  it('renders protocol incompatibility and bounds runtime errors', () => {
    const {component, target} = mountInstalledPluginList({
      items: [plugin({
        runtime: {
          state: 'stopped',
          restartCount: 0,
          consecutiveFailures: 0,
          requiredProtocol: 2,
          compatible: false,
          supportedProtocols: [1],
          lastError: 'x'.repeat(300),
        },
      })],
    });

    expect(target.textContent).toContain('Protocol 2');
    expect(target.textContent).toContain('incompatible');
    expect(target.textContent).toContain('Supported service protocols: 1');
    expect(target.textContent).not.toContain('x'.repeat(300));
    expect(target.textContent).toContain('…');

    void unmount(component);
  });
});
