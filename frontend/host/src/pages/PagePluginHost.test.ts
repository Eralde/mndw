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
import {PAGE_PLUGIN_LOADING_DELAY_MS, PAGE_PLUGIN_SLOW_TIMEOUT_MS} from '../constants.js';
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

  it('announces the dependency failure notice as an alert', async () => {
    replaceDepsStatuses([{name: 'page-a', depsStatus: 'installing'}]);

    const {component, target} = await setup();

    expect(target.querySelector('.mndw-page-plugin__notice')?.getAttribute('role')).toBe('status');

    replaceDepsStatuses([{name: 'page-a', depsStatus: 'failed'}]);
    flushSync();

    expect(target.querySelector('.mndw-page-plugin__notice')?.getAttribute('role')).toBe('alert');
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

    const {component, target} = await setup();
    const registered = dispatchReload({pluginName: 'page-a', next, prior});

    expect(await registered).toBe(false);
    expect(createInstanceMock(next)).toHaveBeenCalledOnce();
    expect(createInstanceMock(prior)).toHaveBeenCalledOnce();

    // The hot-reload transaction never shows a host status panel: neither the
    // failed candidate's error panel nor any loading indicator may appear
    // alongside the restored prior page.
    expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
    expect(target.querySelector('.mndw-page-plugin__mount')).not.toBeNull();
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

  describe('mount status panels', () => {
    // Setup variant: navigate with real timers, then fake only the host's status
    // timers before mounting so nothing outside the host clock is faked.
    async function setupWithTimers(): Promise<{component: ReturnType<typeof mount>; target: HTMLElement}> {
      router = createAppRouter();
      await router.navigate('/page-a');

      vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});

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

    /** Drains pending microtask chains (promise settlements) without touching timers. */
    async function settle(): Promise<void> {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }

      flushSync();
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows no loading indicator when createInstance resolves immediately', async () => {
      const {target} = await setupWithTimers();

      await settle();
      expect(createInstanceMock(pageA)).toHaveBeenCalledOnce();
      expect(target.querySelector('.mndw-page-plugin__mount')).not.toBeNull();

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_LOADING_DELAY_MS);
      flushSync();

      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBeNull();
    });

    it('shows loading indicator after grace and hides it on resolve', async () => {
      const pending = deferred<PluginInstance>();

      createInstanceMock(pageA).mockReturnValueOnce(pending.promise);

      const {target} = await setupWithTimers();

      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBe('true');

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_LOADING_DELAY_MS);
      flushSync();

      const loading = target.querySelector('.mndw-page-plugin__notice');

      expect(loading?.getAttribute('role')).toBe('status');
      expect(loading?.textContent).toBe(hostT('page-plugin.opening', {title: 'page-a'}));
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBe('true');

      pending.resolve({unmount: vi.fn()});
      await settle();

      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBeNull();
      expect(target.querySelector('.mndw-page-plugin__mount')).not.toBeNull();
    });

    it('shows error panel on rejection and retries with a fresh mount', async () => {
      const failing = deferred<PluginInstance>();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      createInstanceMock(pageA).mockImplementationOnce((container) => {
        // A plugin may leave partial DOM behind before failing.
        const marker = document.createElement('div');

        marker.className = 'plugin-error-marker';
        container.appendChild(marker);

        return failing.promise;
      });

      const {target} = await setupWithTimers();
      const firstContext = contextFor(pageA);

      failing.reject(new Error('initialization failed'));
      await settle();

      const panel = target.querySelector('.mndw-page-plugin__notice');

      expect(panel?.getAttribute('role')).toBe('alert');
      expect(panel?.textContent).toContain(hostT('page-plugin.open-error', {title: 'page-a'}));
      expect(panel?.textContent).toContain(hostT('common.retry'));
      expect(panel?.querySelector('mndw-button')?.getAttribute('variant')).toBe('secondary');
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBeNull();
      expect(firstContext.signal.aborted).toBe(true);

      // The plugin's own error DOM must not stay visible alongside the panel.
      expect(target.querySelector('.plugin-error-marker')).toBeNull();

      // Second attempt succeeds synchronously.
      createInstanceMock(pageA).mockReturnValueOnce({unmount: vi.fn()});
      panel?.querySelector('mndw-button')?.click();
      flushSync();

      expect(createInstanceMock(pageA)).toHaveBeenCalledTimes(2);

      await settle();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelector('.mndw-page-plugin__mount')).not.toBeNull();
      expect(contextFor(pageA, -1).signal.aborted).toBe(false);
      consoleError.mockRestore();
    });

    it('shows slow panel after 10 s and hides it on late resolve without disposing', async () => {
      const pending = deferred<PluginInstance>();

      createInstanceMock(pageA).mockReturnValueOnce(pending.promise);

      const {target} = await setupWithTimers();
      const context = contextFor(pageA);
      const handle = contextHandleFor(context);

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_SLOW_TIMEOUT_MS);
      flushSync();

      const panel = target.querySelector('.mndw-page-plugin__notice');

      expect(panel?.getAttribute('role')).toBe('alert');
      expect(panel?.textContent).toContain(hostT('page-plugin.slow'));
      expect(panel?.textContent).toContain(hostT('common.retry'));
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBe('true');

      // Late resolve: page shows normally and the slow panel disappears. The
      // mount must NOT have been disposed on timeout.
      pending.resolve({unmount: vi.fn()});
      await settle();

      expect(handle.dispose).not.toHaveBeenCalled();
      expect(context.signal.aborted).toBe(false);
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelector('.mndw-page-plugin__mount')).not.toBeNull();
    });

    it('retry from the slow panel disposes the pending mount and remounts', async () => {
      const pending = deferred<PluginInstance>();

      createInstanceMock(pageA).mockReturnValueOnce(pending.promise);

      const {target} = await setupWithTimers();
      const staleContext = contextFor(pageA);
      const staleHandle = contextHandleFor(staleContext);

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_SLOW_TIMEOUT_MS);
      flushSync();

      createInstanceMock(pageA).mockReturnValueOnce({unmount: vi.fn()});
      target.querySelector<HTMLElement>('.mndw-page-plugin__panel mndw-button')?.click();
      flushSync();

      expect(createInstanceMock(pageA)).toHaveBeenCalledTimes(2);
      expect(staleHandle.dispose).toHaveBeenCalledOnce();
      expect(staleContext.signal.aborted).toBe(true);

      await settle();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelectorAll('.mndw-page-plugin__mount')).toHaveLength(1);

      // The disposed pending mount resolving late must not change anything.
      pending.resolve({unmount: vi.fn()});
      await settle();

      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      expect(target.querySelectorAll('.mndw-page-plugin__mount')).toHaveLength(1);
    });

    it('clears pending status on navigation and never shows a stale indicator', async () => {
      const pending = deferred<PluginInstance>();

      createInstanceMock(pageA).mockReturnValueOnce(pending.promise);
      createInstanceMock(pageB).mockImplementationOnce(() => ({unmount: vi.fn()}));

      const {target} = await setupWithTimers();

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_LOADING_DELAY_MS);
      flushSync();
      expect(target.querySelector('.mndw-page-plugin__notice')).not.toBeNull();

      await router.navigate('/page-b');
      flushSync();

      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();

      // Stale timers were cleared: advancing must not resurrect the indicator.
      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_SLOW_TIMEOUT_MS);
      flushSync();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();

      pending.resolve({unmount: vi.fn()});
      await settle();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
    });

    it('clears the error panel when navigating away', async () => {
      const failing = deferred<PluginInstance>();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      createInstanceMock(pageA).mockReturnValueOnce(failing.promise);
      createInstanceMock(pageB).mockImplementationOnce(() => ({unmount: vi.fn()}));

      const {target} = await setupWithTimers();

      failing.reject(new Error('initialization failed'));
      await settle();
      expect(target.querySelector('.mndw-page-plugin__notice')).not.toBeNull();

      await router.navigate('/page-b');
      flushSync();

      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
      consoleError.mockRestore();
    });

    it('keeps one current mount through a quick A→B→A navigation with pending A', async () => {
      const pendingA = deferred<PluginInstance>();

      createInstanceMock(pageA)
        .mockReturnValueOnce(pendingA.promise)
        .mockImplementationOnce(() => ({unmount: vi.fn()}));
      createInstanceMock(pageB).mockImplementationOnce(() => ({unmount: vi.fn()}));

      const {target} = await setupWithTimers();

      await router.navigate('/page-b');
      flushSync();
      await router.navigate('/page-a');
      flushSync();
      await settle();

      expect(createInstanceMock(pageA)).toHaveBeenCalledTimes(2);
      expect(target.querySelectorAll('.mndw-page-plugin__mount')).toHaveLength(1);
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();

      pendingA.resolve({unmount: vi.fn()});
      await settle();

      expect(target.querySelectorAll('.mndw-page-plugin__mount')).toHaveLength(1);
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
    });

    it('shows the error panel when createInstance throws synchronously', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      createInstanceMock(pageA).mockImplementationOnce(() => {
        throw new Error('sync failure');
      });

      const {target} = await setupWithTimers();

      await settle();

      const panel = target.querySelector('.mndw-page-plugin__notice');

      expect(panel?.getAttribute('role')).toBe('alert');
      expect(panel?.textContent).toContain(hostT('page-plugin.open-error', {title: 'page-a'}));
      expect(panel?.querySelector('mndw-button')).not.toBeNull();
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBeNull();
      consoleError.mockRestore();
    });

    it('clears pending timers on destroy and shows no late state', async () => {
      const pending = deferred<PluginInstance>();

      createInstanceMock(pageA).mockReturnValueOnce(pending.promise);

      const {component, target} = await setupWithTimers();

      expect(vi.getTimerCount()).toBe(2);

      await unmountTracked(component);

      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_SLOW_TIMEOUT_MS);
      flushSync();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();

      pending.resolve({unmount: vi.fn()});
      await settle();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
    });

    it('shows error + Retry when a hot reload fails while already in the error state', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const next = pagePlugin('page-a');
      const prior = pagePlugin('page-a');

      createInstanceMock(pageA).mockImplementationOnce(() => {
        throw new Error('initial failure');
      });
      createInstanceMock(next).mockImplementationOnce(() => {
        throw new Error('candidate failed');
      });
      createInstanceMock(prior).mockImplementationOnce(() => {
        throw new Error('prior still failed');
      });

      const {target} = await setupWithTimers();

      await settle();
      expect(target.querySelector('.mndw-page-plugin__notice')?.getAttribute('role')).toBe('alert');

      const registered = dispatchReload({pluginName: 'page-a', next, prior});

      expect(registered).not.toBeNull();
      expect(await registered).toBe(false);
      await settle();

      const panel = target.querySelector('.mndw-page-plugin__notice');

      expect(panel?.getAttribute('role')).toBe('alert');
      expect(panel?.textContent).toContain(hostT('page-plugin.open-error', {title: 'page-a'}));
      expect(panel?.querySelector('mndw-button')).not.toBeNull();
      consoleError.mockRestore();
    });

    it('shows the slow panel while a hot-reload candidate hangs', async () => {
      const next = pagePlugin('page-a');
      const prior = pagePlugin('page-a');
      const hung = deferred<PluginInstance>();

      createInstanceMock(next).mockReturnValueOnce(hung.promise);

      const {target} = await setupWithTimers();

      await settle();

      const registered = dispatchReload({pluginName: 'page-a', next, prior});

      expect(registered).not.toBeNull();
      expect(createInstanceMock(next)).toHaveBeenCalledOnce();
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_LOADING_DELAY_MS);
      flushSync();
      expect(target.querySelector('.mndw-page-plugin__notice')?.getAttribute('role')).toBe('status');
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBe('true');

      await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_SLOW_TIMEOUT_MS);
      flushSync();

      const panel = target.querySelector('.mndw-page-plugin__notice');

      expect(panel?.getAttribute('role')).toBe('alert');
      expect(panel?.textContent).toContain(hostT('page-plugin.slow'));
      expect(panel?.querySelector('mndw-button')).not.toBeNull();
      expect(target.querySelector('.mndw-page-plugin')?.getAttribute('aria-busy')).toBe('true');
      expect(createInstanceMock(prior)).not.toHaveBeenCalled();

      hung.resolve({unmount: vi.fn()});
      await settle();

      expect(await registered).toBe(true);
      expect(target.querySelector('.mndw-page-plugin__notice')).toBeNull();
    });

    it('names the page with the sidebar manifest label, not the catalog title', async () => {
      const pending = deferred<PluginInstance>();
      const labeled = pagePlugin('page-a');
      const previousLocale = appState.locale;

      labeled.entry.label = 'Sidebar Label';
      labeled.catalog = {
        readCurrentState: () => ({
          primaryCatalog: {title: 'Catalog Title'},
          defaultCatalog: {title: 'Catalog Title'},
        }),
      } as unknown as NonNullable<LoadedPage['catalog']>;
      vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
        name === 'page-a' ? labeled : name === 'page-b' ? pageB : undefined
      );
      createInstanceMock(labeled).mockReturnValueOnce(pending.promise);

      const {target} = await setupWithTimers();

      try {
        await vi.advanceTimersByTimeAsync(PAGE_PLUGIN_LOADING_DELAY_MS);
        flushSync();

        const notice = target.querySelector('.mndw-page-plugin__notice');

        expect(notice?.textContent).toBe(hostT('page-plugin.opening', {title: 'Sidebar Label'}));
        expect(notice?.textContent).not.toContain('Catalog Title');

        appState.locale = 'ru';
        flushSync();

        expect(target.querySelector('.mndw-page-plugin__notice')?.textContent).toBe(
          hostT('page-plugin.opening', {title: 'Sidebar Label'}),
        );
      } finally {
        appState.locale = previousLocale;
      }

      pending.resolve({unmount: vi.fn()});
      await settle();
    });
  });
});
