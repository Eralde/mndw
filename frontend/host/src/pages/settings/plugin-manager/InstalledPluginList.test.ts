// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import type {PluginCapability} from '@mndw/sdk-internal';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('@mndw/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mndw/sdk')>();

  return {...actual, SDK_VERSION: '0.2.0'};
});

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import * as pluginLoader from '../../../runtime/plugin-loader.js';
import {PLUGIN_LOAD_TIMEOUT_MS} from '../../../runtime/plugin-loader.js';
import {replacePluginLoadStates, setPluginLoadState} from '../../../runtime/plugin-load-state.svelte.js';
import {clearPluginVersionWarnings, setPluginVersionWarnings} from '../../../runtime/plugin-version-warnings.svelte.js';
import {replaceDepsStatuses} from '../../../state/deps-status.svelte.js';
import {setLocale} from '../../../services/locale.service.js';
import InstalledPluginList from './InstalledPluginList.svelte';
import type {PluginRowState} from './reconcile.js';

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
  confirmingName: string | null;
  rowStateFor: (name: string) => PluginRowState | undefined;
  capabilityVisible: boolean;
  capabilityAvailable: boolean;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onCapabilityChange: (name: string, capability: PluginCapability, enabled: boolean) => void;
  onDelete: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
  onRefresh: () => void;
  onKeepNotice: (name: string) => void;
}> = {}): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(InstalledPluginList, {
    target,
    props: {
      items: [plugin()],
      confirmingName: null,
      rowStateFor: () => undefined,
      capabilityVisible: false,
      capabilityAvailable: false,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
      onCapabilityChange: vi.fn(),
      onDelete: vi.fn(),
      onRequestConfirm: vi.fn(),
      onCancelConfirm: vi.fn(),
      onRefresh: vi.fn(),
      onKeepNotice: vi.fn(),
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
    replacePluginLoadStates([]);
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows a shared empty state with a link to upload the first plugin', () => {
    const {component, target} = mountInstalledPluginList({items: []});

    expect(target.textContent).toContain('Installed plugins');

    const emptyState = target.querySelector('.mndw-empty-state');

    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain('No plugins installed.');
    expect(target.querySelector('.mndw-empty-state__link')?.getAttribute('href')).toBe('#mndw-plugin-upload');

    void unmount(component);
  });

  it('updates installed-plugin labels after a locale commit', async () => {
    const {component, target} = mountInstalledPluginList();

    try {
      expect(target.textContent).toContain('Installed plugins');
      expect(target.textContent).toContain('Version: 1.0.0');
      expect(target.textContent).toContain('Disable');
      expect(target.textContent).toContain('Delete');

      await setLocale('ru');
      flushSync();

      expect(target.textContent).toContain('Установленные плагины');
      expect(target.textContent).toContain('Версия: 1.0.0');
      expect(target.textContent).toContain('Отключить');
      expect(target.textContent).toContain('Удалить');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
  });

  it('disables an enabled user plugin', () => {
    const onDisable = vi.fn();
    const {component, target} = mountInstalledPluginList({onDisable});

    expect(target.textContent).toContain('Network Tools');
    expect(target.textContent).toContain('1.0.0');
    expect(target.textContent).toContain('Widget');
    expect(target.textContent).not.toContain('Source:');

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
      rowStateFor: (name) =>
        name === 'network-tools'
          ? {state: 'working', message: ''}
          : undefined,
      confirmingName: 'network-tools',
    });

    expect(target.querySelector<HTMLButtonElement>('.mndw-installed__cancel')?.disabled).toBe(true);

    void unmount(component);
  });

  it('renders builtin plugin badge with enablement control and no delete control', () => {
    const onDisable = vi.fn();
    const {component, target} = mountInstalledPluginList({
      items: [plugin({source: 'builtin'})],
      onDisable,
    });

    expect(target.querySelector('.mndw-installed__builtin')?.textContent).toContain('Built-in');
    expect(target.querySelector<HTMLButtonElement>('.mndw-installed__toggle')?.textContent).toContain('Disable');
    expect(target.querySelector('.mndw-installed__delete')).toBeNull();

    target.querySelector<HTMLButtonElement>('.mndw-installed__toggle')?.click();
    expect(onDisable).toHaveBeenCalledWith('network-tools');

    void unmount(component);
  });

  it('hides capability switch when capability is hidden or capability is undeclared', () => {
    const hidden = mountInstalledPluginList({
      capabilityVisible: false,
      items: [plugin({capabilities: ['persistent-rci-session:write']})],
    });

    expect(hidden.target.querySelector('.mndw-installed__capability-switch')).toBeNull();
    void unmount(hidden.component);

    const undeclared = mountInstalledPluginList({capabilityVisible: true});

    expect(undeclared.target.querySelector('.mndw-installed__capability-switch')).toBeNull();
    void unmount(undeclared.component);
  });

  it('renders an off capability switch and reports an optimistic enable', () => {
    const onCapabilityChange = vi.fn();
    const {component, target} = mountInstalledPluginList({
      capabilityVisible: true,
      capabilityAvailable: true,
      onCapabilityChange,
      items: [plugin({capabilities: ['persistent-rci-session:write']})],
    });
    const control = target.querySelector<HTMLElement & {checked: boolean; disabled: boolean}>(
      '.mndw-installed__capability-switch mndw-switch',
    );

    expect(control?.checked).toBe(false);
    expect(control?.disabled).toBe(false);
    control?.click();
    expect(onCapabilityChange).toHaveBeenCalledWith('network-tools', 'persistent-rci-session:write', true);

    void unmount(component);
  });

  it('disables only off capability switches when controller capability is unavailable', () => {
    const off = mountInstalledPluginList({
      capabilityVisible: true,
      capabilityAvailable: false,
      items: [plugin({capabilities: ['persistent-rci-session:write']})],
    });
    const offControl = off.target.querySelector<HTMLElement & {disabled: boolean}>(
      '.mndw-installed__capability-switch mndw-switch',
    );

    expect(offControl?.disabled).toBe(true);
    void unmount(off.component);

    const checked = mountInstalledPluginList({
      capabilityVisible: true,
      capabilityAvailable: false,
      items: [
        plugin({capabilities: ['persistent-rci-session:write'],
          capabilityGrants: {'persistent-rci-session:write': true}}),
      ],
    });
    const checkedControl = checked.target.querySelector<HTMLElement & {disabled: boolean}>(
      '.mndw-installed__capability-switch mndw-switch',
    );

    expect(checkedControl?.disabled).toBe(false);
    void unmount(checked.component);
  });

  it('renders capability and enablement controls for builtins without delete control', () => {
    const {component, target} = mountInstalledPluginList({
      capabilityVisible: true,
      capabilityAvailable: true,
      items: [plugin({source: 'builtin', capabilities: ['persistent-rci-session:write']})],
    });

    expect(target.querySelector('.mndw-installed__capability-switch')).not.toBeNull();
    expect(target.querySelector('.mndw-installed__toggle')).not.toBeNull();
    expect(target.querySelector('.mndw-installed__delete')).toBeNull();

    void unmount(component);
  });

  it('disables capability switch while another action is busy', () => {
    const {component, target} = mountInstalledPluginList({
      capabilityVisible: true,
      capabilityAvailable: true,
      rowStateFor: (name) =>
        name === 'network-tools'
          ? {state: 'working', message: ''}
          : undefined,
      items: [plugin({capabilities: ['persistent-rci-session:write']})],
    });
    const control = target.querySelector<HTMLElement & {disabled: boolean}>(
      '.mndw-installed__capability-switch mndw-switch',
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

  it.each([
    {locale: 'en', count: 1, expectedEndpoint: '1 endpoint', expectedWebsocket: '1 websocket'},
    {locale: 'en', count: 2, expectedEndpoint: '2 endpoints', expectedWebsocket: '2 websockets'},
    {locale: 'ru', count: 1, expectedEndpoint: '1 конечная точка', expectedWebsocket: '1 веб-сокет'},
    {locale: 'ru', count: 2, expectedEndpoint: '2 конечные точки', expectedWebsocket: '2 веб-сокета'},
    {locale: 'ru', count: 5, expectedEndpoint: '5 конечных точек', expectedWebsocket: '5 веб-сокетов'},
    {locale: 'ru', count: 21, expectedEndpoint: '21 конечная точка', expectedWebsocket: '21 веб-сокет'},
  ])('formats $locale backend counts for $count routes', async ({
    locale,
    count,
    expectedEndpoint,
    expectedWebsocket,
  }) => {
    await setLocale(locale);

    const routes: Record<string, {transport: 'http' | 'websocket'; path: string}> = {};

    for (let index = 0; index < count; index += 1) {
      routes[`http-${index}`] = {transport: 'http', path: `http-${index}`};
      routes[`websocket-${index}`] = {transport: 'websocket', path: `websocket-${index}`};
    }

    const {component, target} = mountInstalledPluginList({
      items: [plugin({backend: {routes}})],
    });

    try {
      expect(target.textContent).toContain(expectedEndpoint);
      expect(target.textContent).toContain(expectedWebsocket);
    } finally {
      await unmount(component);
      await setLocale('en');
    }
  });

  it.each([
    {locale: 'en', type: 'widget', expected: 'Widget'},
    {locale: 'ru', type: 'widget', expected: 'Виджет'},
    {locale: 'en', type: 'page', expected: 'Page'},
    {locale: 'ru', type: 'page', expected: 'Страница'},
  ])('translates $type plugin type in $locale', async ({locale, type, expected}) => {
    await setLocale(locale);

    const {component, target} = mountInstalledPluginList({
      items: [plugin({type} as Partial<PluginListEntry>)],
    });

    try {
      expect(target.textContent).toContain(expected);
      expect(target.textContent).not.toContain('Type:');
      expect(target.textContent).not.toContain('Source:');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
  });

  it('shows a source badge for built-in and uploaded plugins', async () => {
    await setLocale('en');

    const builtin = mountInstalledPluginList({
      items: [plugin({source: 'builtin'})],
    });

    expect(builtin.target.querySelectorAll('.mndw-installed__builtin')).toHaveLength(1);
    expect(builtin.target.textContent).not.toContain('Source:');
    void unmount(builtin.component);

    const uploaded = mountInstalledPluginList({
      items: [plugin({source: 'upload'})],
    });

    expect(uploaded.target.querySelector('.mndw-installed__builtin')?.textContent).toContain('Uploaded');
    expect(uploaded.target.textContent).not.toContain('Source:');
    await unmount(uploaded.component);
    await setLocale('en');
  });

  it('renders a persistent version mismatch badge on the matching plugin row', () => {
    setPluginVersionWarnings('network-tools', ['rxjs @6 (host provides @7)']);

    const {component, target} = mountInstalledPluginList();

    expect(target.querySelector('.mndw-installed__version-badge')?.textContent).toContain('Version mismatch');
    expect(target.querySelector('.mndw-installed__version-warning')?.textContent).toContain('rxjs @6');

    void unmount(component);
  });

  it('shows a localized SDK-major badge and visible warning for an installed plugin with an older SDK major', async () => {
    const {component, target} = mountInstalledPluginList({
      items: [plugin({lock: {sdkVersion: '0.1.6', sharedDependencies: {}}})],
    });
    const badge = target.querySelector<HTMLElement>('.mndw-installed__version-badge');
    const warning = target.querySelector<HTMLElement>('.mndw-installed__version-warning');

    try {
      expect(badge?.textContent?.trim()).toBe('Built for another SDK version');
      expect(warning?.textContent?.trim())
        .toBe('Built for @mndw/sdk 0.1.6; this dashboard provides 0.2.0. The plugin may not work.');
      expect(badge?.getAttribute('role')).toBeNull();
      expect(badge?.getAttribute('aria-label')).toBeNull();
      expect(badge?.getAttribute('title')).toBeNull();
      expect(warning?.getAttribute('role')).toBeNull();
      expect(warning?.getAttribute('aria-label')).toBeNull();
      expect(warning?.getAttribute('title')).toBeNull();

      await setLocale('ru');
      flushSync();

      expect(badge?.textContent?.trim()).toBe('Собран для другой версии SDK');
      expect(warning?.textContent?.trim())
        .toBe('Собрано для @mndw/sdk 0.1.6; эта панель предоставляет 0.2.0. Плагин может не работать.');
    } finally {
      await unmount(component);
      await setLocale('en');
    }
  });

  it('does not show an SDK-major badge for a matching SDK version or a missing lock', () => {
    const matching = mountInstalledPluginList({
      items: [plugin({lock: {sdkVersion: '0.2.0', sharedDependencies: {}}})],
    });

    expect(matching.target.querySelector('.mndw-installed__version-badge')).toBeNull();
    expect(matching.target.querySelector('.mndw-installed__version-warning')).toBeNull();
    void unmount(matching.component);

    const missing = mountInstalledPluginList();

    expect(missing.target.querySelector('.mndw-installed__version-badge')).toBeNull();
    expect(missing.target.querySelector('.mndw-installed__version-warning')).toBeNull();
    void unmount(missing.component);
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

  it.each(
    [
      ['timeout', `Did not load within ${PLUGIN_LOAD_TIMEOUT_MS / 1_000} seconds`],
      ['error', 'The plugin file did not load or contains an error'],
    ] as const,
  )('shows failed-load marker and reason for %s failures', (failureKind, reason) => {
    const entry = plugin();

    replacePluginLoadStates([entry]);
    setPluginLoadState(entry.name, 'failed', failureKind);

    const {component, target} = mountInstalledPluginList({items: [entry]});

    expect(target.querySelector('.mndw-installed__load-failed-badge')?.textContent ?? '')
      .toContain('Failed to load');
    expect(target.querySelector('.mndw-installed__load-failed-reason')?.textContent ?? '')
      .toContain(reason);
    expect(target.querySelector('.mndw-installed__load-retry')?.textContent ?? '')
      .toContain('Retry');

    void unmount(component);
  });

  it('does not show failed-load marker for loaded, disabled, or pending plugins', () => {
    const loadedEntry = plugin();

    replacePluginLoadStates([loadedEntry]);
    setPluginLoadState(loadedEntry.name, 'loaded');

    const loaded = mountInstalledPluginList({items: [loadedEntry]});

    expect(loaded.target.querySelector('.mndw-installed__load-failed-badge')).toBeNull();
    void unmount(loaded.component);

    const disabledEntry = plugin({enabled: false});

    replacePluginLoadStates([plugin()]);
    setPluginLoadState(disabledEntry.name, 'failed', 'error');

    const disabled = mountInstalledPluginList({items: [disabledEntry]});

    expect(disabled.target.querySelector('.mndw-installed__load-failed-badge')).toBeNull();
    void unmount(disabled.component);

    const pendingEntry = plugin({approval: 'pending'});

    replacePluginLoadStates([plugin()]);
    setPluginLoadState(pendingEntry.name, 'failed', 'error');

    const pending = mountInstalledPluginList({items: [pendingEntry]});

    expect(pending.target.querySelector('.mndw-installed__load-failed-badge')).toBeNull();
    void unmount(pending.component);
  });

  it('keeps retry busy while in flight and removes marker after a successful retry', async () => {
    const entry = plugin();
    let resolveRetry: ((loaded: boolean) => void) | undefined;
    const retryPromise = new Promise<boolean>((resolve) => {
      resolveRetry = resolve;
    });
    const retry = vi.spyOn(pluginLoader, 'retryPluginLoad').mockReturnValue(retryPromise);

    replacePluginLoadStates([entry]);
    setPluginLoadState(entry.name, 'failed', 'error');

    const {component, target} = mountInstalledPluginList({items: [entry]});
    const button = target.querySelector<HTMLElement & {disabled: boolean}>('.mndw-installed__load-retry');

    expect(button).not.toBeNull();
    button?.click();
    flushSync();

    expect(retry).toHaveBeenCalledWith(entry.name);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');

    setPluginLoadState(entry.name, 'loaded');
    resolveRetry?.(true);

    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-installed__load-failed-badge')).toBeNull();
      expect(target.querySelector('.mndw-installed__load-failed-reason')).toBeNull();
      expect(target.querySelector('.mndw-installed__load-retry')).toBeNull();
    });

    await unmount(component);
  });

  it('keeps failed-load marker after retry fails', async () => {
    const entry = plugin();
    const retry = vi.spyOn(pluginLoader, 'retryPluginLoad').mockResolvedValue(false);

    replacePluginLoadStates([entry]);
    setPluginLoadState(entry.name, 'failed', 'error');

    const {component, target} = mountInstalledPluginList({items: [entry]});
    const button = target.querySelector<HTMLElement & {disabled: boolean}>('.mndw-installed__load-retry');

    expect(button).not.toBeNull();
    button?.click();

    expect(retry).toHaveBeenCalledWith(entry.name);
    await vi.waitFor(() => expect(button?.disabled).toBe(false));
    expect(target.querySelector('.mndw-installed__load-failed-badge')).not.toBeNull();
    expect(target.querySelector('.mndw-installed__load-failed-reason')).not.toBeNull();

    await unmount(component);
  });

  it('shows short runtime state without protocol details or error text', () => {
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

    expect(target.textContent).toContain('Stopped');
    expect(target.textContent).not.toContain('Protocol 2');
    expect(target.textContent).not.toContain('incompatible');
    expect(target.textContent).not.toContain('Supported service protocols: 1');
    expect(target.textContent).not.toContain('x'.repeat(300));
    expect(target.textContent).not.toContain('…');

    void unmount(component);
  });
});
