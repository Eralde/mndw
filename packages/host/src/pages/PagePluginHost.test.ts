import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {get: vi.fn(), getPages: vi.fn(() => []), getWidgets: vi.fn(() => [])},
}));

vi.mock('../runtime/plugin-lifecycle.js', () => ({
  mountPlugin: vi.fn(),
  unmountPlugin: vi.fn(),
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn((_entry: unknown, instanceId: string) => ({instanceId})),
}));

import type {MndwPlugin} from '@mndw/sdk';
import {type MountedPlugin, mountPlugin, unmountPlugin} from '../runtime/plugin-lifecycle.js';
import {type LoadedPage, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry} from '../runtime/plugin-types.js';
import {SANDBOX_RELOAD_EVENT, type SandboxReloadDetail} from '../runtime/sandbox-loader.js';
import {appState} from '../state/app.svelte.js';
import {createAppRouter} from '../router/create-app-router.js';
import PagePluginHost from './PagePluginHost.svelte';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function pagePlugin(name: string): LoadedPage {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    backend: emptyBackend,
    type: 'page',
    route: `/${name}`,
  };

  return {entry, module: {createInstance: vi.fn()} as unknown as MndwPlugin};
}

function fakeMounted(name: string): MountedPlugin {
  return {pluginName: name, instanceId: `${name}:1`, instance: {unmount: vi.fn()}};
}

const pageA = pagePlugin('page-a');
const pageB = pagePlugin('page-b');

let router: ReturnType<typeof createAppRouter>;

async function setup(): Promise<{component: ReturnType<typeof mount>; target: HTMLElement}> {
  vi.mocked(pluginRegistry).getPages.mockReturnValue([pageA, pageB]);
  vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
    name === 'page-a' ? pageA : name === 'page-b' ? pageB : undefined
  );

  router = createAppRouter();
  await router.navigate('/page-a');

  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(PagePluginHost, {target});

  flushSync();

  return {component, target};
}

describe('PagePluginHost', () => {
  beforeEach(() => {
    appState.hostInfo = null;
  });

  afterEach(async () => {
    await router?.navigate('/');
    vi.clearAllMocks();
    document.body.innerHTML = '';
    appState.hostInfo = null;
  });

  it('mounts the routed page into its own child container', async () => {
    vi.mocked(mountPlugin).mockReturnValue(fakeMounted('page-a'));

    const {component, target} = await setup();

    const host = target.querySelector('.mndw-page-plugin');
    const child = host?.querySelector('.mndw-page-plugin__mount');

    expect(child).not.toBeNull();
    expect(mountPlugin).toHaveBeenCalledWith(child, pageA, {instanceId: 'page-a:1'});

    void unmount(component);
  });

  it('keeps the current page when an older async mount resolves late, disposing the stale one', async () => {
    let resolveA!: (value: MountedPlugin | null) => void;
    const pendingA = new Promise<MountedPlugin | null>((resolve) => {
      resolveA = resolve;
    });
    const mountedA = fakeMounted('page-a');

    vi.mocked(mountPlugin)
      .mockReturnValueOnce(pendingA)
      .mockReturnValueOnce(fakeMounted('page-b'));

    const {component, target} = await setup();

    const childA = target.querySelector('.mndw-page-plugin__mount');

    // Navigate to page-b before page-a's mount resolves.
    await router.navigate('/page-b');
    flushSync();

    // The stale async mount now resolves.
    resolveA(mountedA);
    await pendingA;
    await Promise.resolve();

    expect(unmountPlugin).toHaveBeenCalledWith(mountedA, childA, {
      clearStorage: false,
      closeReason: 'host-navigation',
    });

    // Current page (page-b) is still mounted in the host.
    const children = target.querySelectorAll('.mndw-page-plugin__mount');

    expect(children.length).toBe(1);
    expect(mountPlugin).toHaveBeenLastCalledWith(children[0], pageB, {instanceId: 'page-b:1'});

    void unmount(component);
  });

  it('unmounts the previous page exactly once on navigation', async () => {
    vi.mocked(mountPlugin)
      .mockReturnValueOnce(fakeMounted('page-a'))
      .mockReturnValueOnce(fakeMounted('page-b'));

    const {component, target} = await setup();
    const childA = target.querySelector('.mndw-page-plugin__mount');

    await router.navigate('/page-b');
    flushSync();

    expect(unmountPlugin).toHaveBeenCalledTimes(1);
    expect(unmountPlugin).toHaveBeenCalledWith(expect.anything(), childA, {
      clearStorage: false,
      closeReason: 'host-navigation',
    });

    void unmount(component);
  });

  function dispatchReload(
    detail: Omit<SandboxReloadDetail, 'register'>,
  ): Promise<boolean> | null {
    let registered: Promise<boolean> | null = null;
    const full: SandboxReloadDetail = {...detail, register: (result) => {
      registered = result;
    }};

    window.dispatchEvent(new CustomEvent(SANDBOX_RELOAD_EVENT, {detail: full}));

    return registered;
  }

  it('remounts the active page with the candidate module on a sandbox reload', async () => {
    vi.mocked(mountPlugin).mockReturnValue(fakeMounted('page-a'));

    const {component, target} = await setup();
    const childA = target.querySelector('.mndw-page-plugin__mount');
    const next = pagePlugin('page-a');
    const prior = pagePlugin('page-a');

    vi.mocked(mountPlugin).mockClear();
    vi.mocked(unmountPlugin).mockClear();

    const registered = dispatchReload({pluginName: 'page-a', next, prior});
    const ok = await registered;

    expect(ok).toBe(true);
    expect(unmountPlugin).toHaveBeenCalledWith(expect.anything(), childA, {
      clearStorage: false,
      closeReason: 'host-navigation',
    });
    expect(mountPlugin).toHaveBeenCalledWith(expect.anything(), next, {instanceId: 'page-a:1'});

    void unmount(component);
  });

  it('rolls back to the prior page module when the candidate mount fails', async () => {
    vi.mocked(mountPlugin).mockReturnValue(fakeMounted('page-a'));

    const {component} = await setup();
    const next = pagePlugin('page-a');
    const prior = pagePlugin('page-a');

    // Candidate mount fails (null), then the prior module mounts successfully on rollback.
    vi.mocked(mountPlugin)
      .mockReset()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(fakeMounted('page-a'));

    const registered = dispatchReload({pluginName: 'page-a', next, prior});
    const ok = await registered;

    expect(ok).toBe(false);
    expect(mountPlugin).toHaveBeenNthCalledWith(1, expect.anything(), next, {instanceId: 'page-a:1'});
    expect(mountPlugin).toHaveBeenNthCalledWith(2, expect.anything(), prior, {instanceId: 'page-a:1'});

    void unmount(component);
  });

  it('ignores a sandbox reload for a page it is not currently showing', async () => {
    vi.mocked(mountPlugin).mockReturnValue(fakeMounted('page-a'));

    const {component} = await setup();
    const next = pagePlugin('page-b');
    const prior = pagePlugin('page-b');

    vi.mocked(mountPlugin).mockClear();
    vi.mocked(unmountPlugin).mockClear();

    const registered = dispatchReload({pluginName: 'page-b', next, prior});

    expect(registered).toBeNull();
    expect(mountPlugin).not.toHaveBeenCalled();
    expect(unmountPlugin).not.toHaveBeenCalled();

    void unmount(component);
  });

  it('preserves page instance storage on final teardown', async () => {
    const mountedA = fakeMounted('page-a');

    vi.mocked(mountPlugin).mockReturnValue(mountedA);

    const {component, target} = await setup();
    const childA = target.querySelector('.mndw-page-plugin__mount');

    void unmount(component);
    flushSync();

    expect(unmountPlugin).toHaveBeenCalledWith(mountedA, childA, {
      clearStorage: false,
      closeReason: 'host-navigation',
    });
  });
});
