// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('../runtime/plugin-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/plugin-registry.js')>(),
  pluginRegistry: {get: vi.fn(), getPages: vi.fn(() => []), getWidgets: vi.fn(() => [])},
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn((options: {instanceId: string; pageRoute: unknown}) => {
    const controller = new AbortController();

    return {
      context: {
        kind: 'page',
        instanceId: options.instanceId,
        pageRoute: options.pageRoute,
        signal: controller.signal,
      },
      dispose: vi.fn(() => controller.abort()),
    };
  }),
}));

vi.mock('../services/storage.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/storage.service.js')>(),
  clearInstanceStorage: vi.fn(),
}));

import type {MndwPlugin, PluginContext, PluginInstance} from '@mndw/sdk';
import {type PluginContextHandle, createPluginContext} from '../runtime/plugin-context.js';
import {type LoadedPage, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry} from '../runtime/plugin-types.js';
import {SANDBOX_RELOAD_EVENT, type SandboxReloadDetail} from '../runtime/sandbox-loader.js';
import {appState} from '../state/app.svelte.js';
import {createAppRouter} from '../router/create-app-router.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import PagePluginHost from './PagePluginHost.svelte';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import {hostT} from '../services/host-i18n.svelte.js';

const emptyBackend = {routes: {}};

function pagePlugin(name: string): LoadedPage {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'page',
    route: `/${name}`,
  };
  const createInstance = vi.fn((_container: HTMLElement, _context: PluginContext): PluginInstance => ({
    unmount: vi.fn(),
  }));

  return {entry, module: {createInstance} as unknown as MndwPlugin};
}

function createInstanceMock(plugin: LoadedPage) {
  return vi.mocked(plugin.module.createInstance);
}

function contextFor(plugin: LoadedPage, callIndex = -1): PluginContext {
  const context = createInstanceMock(plugin).mock.calls.at(callIndex)?.[1];

  if (context === undefined) {
    throw new Error(`No context passed to ${plugin.entry.name}`);
  }

  return context;
}

function contextHandleFor(context: PluginContext): PluginContextHandle {
  const result = vi.mocked(createPluginContext).mock.results.find(({value}) =>
    (value as PluginContextHandle).context === context
  );

  if (result === undefined) {
    throw new Error('Plugin context handle was not created');
  }

  return result.value as PluginContextHandle;
}

function instanceFor(plugin: LoadedPage, callIndex = -1): PluginInstance {
  const instance = createInstanceMock(plugin).mock.results.at(callIndex)?.value;

  if (instance === undefined || instance instanceof Promise) {
    throw new Error(`No synchronous instance returned by ${plugin.entry.name}`);
  }

  return instance as PluginInstance;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {promise, resolve, reject};
}

const pageA = pagePlugin('page-a');
const pageB = pagePlugin('page-b');

let router: ReturnType<typeof createAppRouter>;
const components: Array<ReturnType<typeof mount>> = [];

async function unmountTracked(component: ReturnType<typeof mount>): Promise<void> {
  const index = components.indexOf(component);

  if (index >= 0) {
    components.splice(index, 1);
  }

  await unmount(component);
}

async function setup(): Promise<{component: ReturnType<typeof mount>; target: HTMLElement}> {
  vi.mocked(pluginRegistry).getPages.mockReturnValue([pageA, pageB]);
  vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
    name === 'page-a' ? pageA : name === 'page-b' ? pageB : undefined
  );

  router = createAppRouter();
  await router.navigate('/page-a');

  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(PagePluginHost, {
    target,
    context: createHostServicesContext({...createHostServices(), registry: pluginRegistry}),
  });

  components.push(component);
  flushSync();

  return {component, target};
}

describe('PagePluginHost', () => {
  beforeEach(async () => {
    appState.hostInfo = null;
    replaceDepsStatuses([]);
    for (const plugin of [pageA, pageB]) {
      createInstanceMock(plugin).mockReset().mockImplementation(() => ({unmount: vi.fn()}));
    }

    vi.mocked(pluginRegistry).getPages.mockReturnValue([pageA, pageB]);
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
      name === 'page-a' ? pageA : name === 'page-b' ? pageB : undefined
    );
    vi.mocked(createPluginContext).mockClear();
    const {clearInstanceStorage} = await import('../services/storage.service.js');

    vi.mocked(clearInstanceStorage).mockClear();
  });

  afterEach(async () => {
    for (const component of components.splice(0)) {
      await unmount(component);
    }

    await router?.navigate('/');
    vi.clearAllMocks();
    replaceDepsStatuses([]);
    document.body.innerHTML = '';
    appState.hostInfo = null;
  });

  it('mounts routed page into its own child container', async () => {
    const pageUnmount = vi.fn();

    createInstanceMock(pageA).mockReturnValueOnce({unmount: pageUnmount});

    const {target} = await setup();
    const child = target.querySelector('.mndw-page-plugin__mount');

    expect(child).not.toBeNull();
    expect(createInstanceMock(pageA)).toHaveBeenCalledWith(
      child,
      expect.objectContaining({instanceId: 'page-a:1', pageRoute: expect.anything()}),
    );

    await unmountTracked(components[0]!);
    expect(pageUnmount).toHaveBeenCalledOnce();
  });

  it('keeps one page instance while child routes change and exposes controller navigation', async () => {
    const {component} = await setup();
    const context = contextFor(pageA);
    const seen: string[] = [];
    const unsubscribe = context.pageRoute?.childPath$.subscribe((path) => seen.push(path));

    await router.navigate('/page-a/clients');
    flushSync();

    expect(createInstanceMock(pageA)).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['', '/clients']);

    await context.pageRoute?.navigate('/settings');
    expect(router.route.pathname).toBe('/page-a/settings');
    expect(createInstanceMock(pageA)).toHaveBeenCalledTimes(1);

    unsubscribe?.unsubscribe();
    void component;
  });

  it('completes child route stream exactly once during teardown', async () => {
    const {component} = await setup();
    const context = contextFor(pageA);
    let completeCount = 0;

    context.pageRoute?.childPath$.subscribe({complete: () => completeCount += 1});
    await unmountTracked(component);

    expect(completeCount).toBe(1);
  });

  it('lets concurrent real router navigations settle on the later child path', async () => {
    const {component} = await setup();
    const context = contextFor(pageA);
    const pageRoute = context.pageRoute;

    if (pageRoute === undefined) {
      throw new Error('page route context was not created');
    }

    const first = pageRoute.navigate('/first');
    const second = pageRoute.navigate('/second');

    await Promise.all([first, second]);

    expect(router.route.pathname).toBe('/page-a/second');
    expect(createInstanceMock(pageA)).toHaveBeenCalledTimes(1);
    void component;
  });

  it('shows dependency notices without mounting unavailable pages', async () => {
    replaceDepsStatuses([{name: 'page-a', depsStatus: 'installing'}]);

    const {component, target} = await setup();

    expect(target.querySelector('.mndw-page-plugin__notice')?.textContent).toBe(
      hostT('dashboard.preparing-dependencies'),
    );
    expect(target.querySelector('.mndw-page-plugin-wrap .mndw-page-plugin')).not.toBeNull();
    expect(createInstanceMock(pageA)).not.toHaveBeenCalled();

    replaceDepsStatuses([{name: 'page-a', depsStatus: 'failed'}]);
    flushSync();
    expect(target.querySelector('.mndw-page-plugin__notice')?.textContent).toBe(
      hostT('dashboard.dependency-install-failed'),
    );
    expect(createInstanceMock(pageA)).not.toHaveBeenCalled();
    void component;
  });

  it('mounts page when dependencies become ready', async () => {
    replaceDepsStatuses([{name: 'page-a', depsStatus: 'installing'}]);

    const {component, target} = await setup();

    expect(createInstanceMock(pageA)).not.toHaveBeenCalled();

    replaceDepsStatuses([{name: 'page-a', depsStatus: 'ready'}]);
    flushSync();

    expect(createInstanceMock(pageA)).toHaveBeenCalledOnce();
    expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
    void component;
  });

  it('disposes context immediately on dependency change and unmounts late instance once', async () => {
    const pending = deferred<PluginInstance>();
    const lateUnmount = vi.fn();

    createInstanceMock(pageA).mockReturnValueOnce(pending.promise);

    const {component} = await setup();
    const context = contextFor(pageA);
    const handle = contextHandleFor(context);

    replaceDepsStatuses([{name: 'page-a', depsStatus: 'installing'}]);
    flushSync();

    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledWith('host-navigation');
    expect(context.signal.aborted).toBe(true);

    pending.resolve({unmount: lateUnmount});
    await vi.waitFor(() => expect(lateUnmount).toHaveBeenCalledOnce());

    expect(handle.dispose).toHaveBeenCalledOnce();
    await unmountTracked(component);
    expect(lateUnmount).toHaveBeenCalledOnce();
  });

  it('disposes pending page on navigation and keeps current page DOM after stale resolve', async () => {
    const pending = deferred<PluginInstance>();
    const staleUnmount = vi.fn();
    const currentUnmount = vi.fn();
    const marker = document.createElement('span');

    marker.className = 'current-page-marker';
    createInstanceMock(pageA).mockReturnValueOnce(pending.promise);
    createInstanceMock(pageB).mockImplementationOnce((container) => {
      container.appendChild(marker);

      return {unmount: currentUnmount};
    });

    const {component, target} = await setup();
    const staleContext = contextFor(pageA);
    const staleHandle = contextHandleFor(staleContext);

    await router.navigate('/page-b');
    flushSync();

    expect(staleHandle.dispose).toHaveBeenCalledOnce();
    expect(staleHandle.dispose).toHaveBeenCalledWith('host-navigation');
    expect(staleContext.signal.aborted).toBe(true);

    const currentContext = contextFor(pageB);
    const currentChild = target.querySelector('.mndw-page-plugin__mount');

    expect(currentContext.signal.aborted).toBe(false);
    expect(currentChild?.contains(marker)).toBe(true);

    pending.resolve({unmount: staleUnmount});
    await vi.waitFor(() => expect(staleUnmount).toHaveBeenCalledOnce());

    expect(staleHandle.dispose).toHaveBeenCalledOnce();
    expect(target.querySelectorAll('.mndw-page-plugin__mount')).toHaveLength(1);
    expect(currentChild?.contains(marker)).toBe(true);
    expect(currentUnmount).not.toHaveBeenCalled();

    await unmountTracked(component);
    expect(currentUnmount).toHaveBeenCalledOnce();
  });

  it('handles pending createInstance rejection through real lifecycle helper', async () => {
    const pending = deferred<PluginInstance>();
    const error = new Error('initialization failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    createInstanceMock(pageA).mockReturnValueOnce(pending.promise);

    const {component} = await setup();
    const context = contextFor(pageA);
    const handle = contextHandleFor(context);

    pending.reject(error);
    await vi.waitFor(() => expect(handle.dispose).toHaveBeenCalledOnce());

    expect(handle.dispose).toHaveBeenCalledWith('plugin-unmount');
    expect(context.signal.aborted).toBe(true);
    await unmountTracked(component);
    expect(handle.dispose).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  function dispatchReload(detail: Omit<SandboxReloadDetail, 'register'>): Promise<boolean> | null {
    let registered: Promise<boolean> | null = null;
    const full: SandboxReloadDetail = {...detail, register: (result) => {
      registered = result;
    }};

    window.dispatchEvent(new CustomEvent(SANDBOX_RELOAD_EVENT, {detail: full}));

    return registered;
  }

  it('remounts the active page with the candidate module on sandbox reload', async () => {
    const priorUnmount = vi.fn();

    createInstanceMock(pageA).mockReturnValueOnce({unmount: priorUnmount});

    const {component} = await setup();
    const next = pagePlugin('page-a');
    const prior = pagePlugin('page-a');

    const registered = dispatchReload({pluginName: 'page-a', next, prior});

    expect(await registered).toBe(true);
    expect(priorUnmount).toHaveBeenCalledOnce();
    expect(createInstanceMock(next)).toHaveBeenCalledOnce();
    await unmountTracked(component);
  });

  it('rolls back to prior module when candidate mount fails', async () => {
    const next = pagePlugin('page-a');
    const prior = pagePlugin('page-a');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    createInstanceMock(next).mockImplementationOnce(() => {
      throw new Error('candidate failed');
    });

    const {component} = await setup();
    const registered = dispatchReload({pluginName: 'page-a', next, prior});

    expect(await registered).toBe(false);
    expect(createInstanceMock(next)).toHaveBeenCalledOnce();
    expect(createInstanceMock(prior)).toHaveBeenCalledOnce();
    await unmountTracked(component);
    consoleError.mockRestore();
  });

  it('ignores sandbox reload for a page not currently shown', async () => {
    const {component} = await setup();
    const next = pagePlugin('page-b');
    const prior = pagePlugin('page-b');

    expect(dispatchReload({pluginName: 'page-b', next, prior})).toBeNull();
    expect(createInstanceMock(next)).not.toHaveBeenCalled();
    void component;
  });

  it('preserves page instance storage on final teardown', async () => {
    const {clearInstanceStorage} = await import('../services/storage.service.js');
    const {component} = await setup();

    await unmountTracked(component);

    expect(clearInstanceStorage).not.toHaveBeenCalled();
  });
});
