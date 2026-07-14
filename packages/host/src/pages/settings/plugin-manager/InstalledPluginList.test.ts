import {afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {clearPluginVersionWarnings, setPluginVersionWarnings} from '../../../runtime/plugin-version-warnings.svelte.js';
import InstalledPluginList from './InstalledPluginList.svelte';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function plugin(over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    type: 'widget',
    name: 'network-tools',
    version: '1.0.0',
    label: 'Network Tools',
    entry: 'index.js',
    source: 'user',
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
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
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
      onEnable: vi.fn(),
      onDisable: vi.fn(),
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
  afterEach(() => {
    clearPluginVersionWarnings();
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
    expect(target.textContent).toContain('user');

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

  it('summarizes backend capabilities and public exposure', () => {
    const {component, target} = mountInstalledPluginList({
      items: [plugin({
        backend: {
          endpoints: {status: {method: 'GET', path: '/api/status'}},
          websockets: {events: {path: '/events'}},
          opkg: ['curl'],
          daemon: true,
          public: true,
        },
      })],
    });

    expect(target.textContent).toContain('1 endpoint');
    expect(target.textContent).toContain('1 websocket');
    expect(target.textContent).toContain('1 opkg');
    expect(target.textContent).toContain('Daemon');
    expect(target.querySelector('.mndw-installed__public')?.textContent).toContain('Public backend');

    void unmount(component);
  });

  it('renders a persistent version mismatch badge on the matching plugin row', () => {
    setPluginVersionWarnings('network-tools', ['rxjs @6 (host provides @7)']);

    const {component, target} = mountInstalledPluginList();

    expect(target.querySelector('.mndw-installed__version-badge')?.textContent).toContain('Version mismatch');
    expect(target.querySelector('.mndw-installed__version-warning')?.textContent).toContain('rxjs @6');

    void unmount(component);
  });
});
