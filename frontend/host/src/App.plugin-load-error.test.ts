// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {initAuthenticated} from './services/init-auth.js';
import {loadPlugins} from './runtime/plugin-loader.js';
import type {PluginListEntry} from './runtime/plugin-types.js';
import {uiOverlayService} from './services/overlay/ui-overlay.js';
import {appState, getAuthRunGeneration, resetToLogin} from './state/app.svelte.js';
import {createHostServices, type HostEnv} from './host-services.js';
import {appRouter, createAppRouter} from './router/create-app-router.js';
import {pluginRegistry} from './runtime/plugin-registry.js';
import App from './App.svelte';

const grid = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  save: vi.fn(() => []),
  destroy: vi.fn(),
  getColumn: vi.fn(() => 12),
  getGridItems: vi.fn(() => []),
}));

vi.mock('gridstack', () => ({GridStack: {init: () => grid}}));

vi.mock('./services/init-auth.js', () => ({initAuthenticated: vi.fn()}));

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;
let services: ReturnType<typeof createHostServices>;

function render(withRouter = false, env: HostEnv = {}): void {
  target = document.createElement('div');
  document.body.appendChild(target);
  services = createHostServices(env);

  if (withRouter) {
    pluginRegistry.clear();
    services = {...services, registry: pluginRegistry};
    createAppRouter(services.registry);
  }

  component = mount(App, {target, props: {services}});
  flushSync();
}

/** The retry button host element; class selectors lose the custom-element tag typing. */
type RetryButton = HTMLElement & {disabled: boolean};

function retryButton(root: ParentNode): RetryButton | null {
  return root.querySelector('.mndw-plugin-load-alert mndw-button') as RetryButton | null;
}

beforeAll(() => {
  defineMndwUi({overlay: uiOverlayService, initialLocale: 'en'});
});

beforeEach(() => {
  appState.authenticated = true;
  appState.ready = false;
  appState.locale = 'en';
  appState.pluginLoadError = 'list';
  appState.authInitInFlight = false;
  appState.pluginLoadRevision = 0;
  appState.pluginLoadFailureSeq = 0;
  pluginRegistry.clear();
  vi.mocked(initAuthenticated).mockReset();
});

afterEach(() => {
  void unmount(component);
  uiOverlayService.closeAll();
  document.body.innerHTML = '';
  pluginRegistry.clear();
  globalThis.history.replaceState({}, '', '/');
});

describe('plugin list failure alert', () => {
  it.each([
    ['en', "Couldn't load plugins.", 'Retry'],
    ['ru', 'Не удалось загрузить плагины.', 'Повторить'],
  ])('renders localized alert in %s', async (locale, message, retry) => {
    appState.locale = locale;
    appState.ready = true;
    render(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(message);
    });
    expect(retryButton(target)?.textContent?.trim())
      .toBe(retry);
  });

  it('retries authenticated initialization, marks button busy, then hides alert on success', async () => {
    let finishList: (entries: PluginListEntry[]) => void = () => {};

    vi.mocked(initAuthenticated).mockImplementation(async (retryServices) => {
      appState.authInitInFlight = true;

      await loadPlugins({
        fetchList: () => new Promise((resolve) => {
          finishList = resolve;
        }),
        registry: retryServices.registry,
        catalogService: retryServices.catalog,
        getLocale: () => retryServices.locale.getLocale(),
        importModule: async () => ({createInstance: () => ({unmount() {}})}),
        loadStylesheet: async () => {},
        checkVersions: () => [],
      });

      appState.authInitInFlight = false;

      return getAuthRunGeneration();
    });
    appState.ready = true;
    render(true);

    await vi.waitFor(() => {
      expect(retryButton(target)).not.toBeNull();
    });

    const button = retryButton(target);

    button?.click();
    flushSync();

    expect(initAuthenticated).toHaveBeenCalledWith(services, {preservePluginLoadError: true});
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');

    finishList([{
      name: 'retried',
      type: 'widget',
      version: '1.0.0',
      label: 'Retried',
      entry: 'index.js',
      source: 'upload',
      approval: 'approved',
      enabled: true,
      depsStatus: 'ready',
      size: {w: 4, h: 3},
      backend: {routes: {}},
    } as PluginListEntry]);
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')).toBeNull());
    expect(services.registry.get('retried')).toBeDefined();
  });

  it('remounts dashboard and sidebar after retry registers widgets and pages', async () => {
    appState.ready = true;
    render(true);
    const createPageInstance = vi.fn((container: HTMLElement) => {
      container.textContent = 'Retry page mounted';

      return {unmount() {}};
    });

    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-dashboard-page')).not.toBeNull();
    });

    vi.mocked(initAuthenticated).mockImplementation(async (retryServices) => {
      retryServices.registry.register({
        entry: {
          name: 'retry-widget',
          type: 'widget',
          version: '1.0.0',
          label: 'Retry widget',
          entry: 'index.js',
          source: 'upload',
          approval: 'approved',
          enabled: true,
          depsStatus: 'ready',
          size: {w: 4, h: 3},
          backend: {routes: {}},
        },
        module: {createInstance: () => ({unmount() {}})},
      });
      retryServices.registry.register({
        entry: {
          name: 'retry-page',
          type: 'page',
          version: '1.0.0',
          label: 'Retry page',
          entry: 'index.js',
          source: 'builtin',
          approval: 'approved',
          enabled: true,
          depsStatus: 'ready',
          route: '/retry-page',
          backend: {routes: {}},
        },
        module: {createInstance: createPageInstance},
      });
      createAppRouter(retryServices.registry);
      appState.pluginLoadError = null;

      return getAuthRunGeneration();
    });

    retryButton(target)?.click();

    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-dashboard__empty mndw-button')?.textContent)
        .toContain('Add Widget');
      expect(target.querySelector('a[href="/retry-page"]')?.textContent)
        .toContain('Retry page');
      expect(appRouter.pluginPages.baseRouteOf('retry-page')).toBe('/retry-page');
    }, {timeout: 5000});

    target.querySelector<HTMLAnchorElement>('a[href="/retry-page"]')?.click();

    await vi.waitFor(() => {
      expect(createPageInstance).toHaveBeenCalledOnce();
      expect(target.textContent).toContain('Retry page mounted');
    });

    await appRouter.navigate('/', {replace: true});

    target.querySelector<HTMLElement>('.mndw-dashboard__empty mndw-button')?.click();

    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-floating-panel')?.textContent)
        .toContain('Retry widget');
    });
  });

  it('mounts a deep-linked page plugin exactly once after a successful retry', async () => {
    const actual = await vi.importActual<typeof import('./services/init-auth.js')>('./services/init-auth.js');
    const createPageInstance = vi.fn(() => ({unmount() {}}));

    vi.mocked(initAuthenticated).mockImplementation(async (retryServices, deps) =>
      actual.initAuthenticated(retryServices, {
        ...deps,
        loadPlugins: async (loaderDeps) => {
          await loadPlugins({
            ...loaderDeps,
            fetchList: async () => [{
              name: 'retry-page',
              type: 'page',
              version: '1.0.0',
              label: 'Retry page',
              entry: 'index.js',
              source: 'builtin',
              approval: 'approved',
              enabled: true,
              depsStatus: 'ready',
              route: '/my-page',
              backend: {routes: {}},
            } as PluginListEntry],
            importModule: async () => ({createInstance: createPageInstance}),
            loadStylesheet: async () => {},
            checkVersions: () => [],
          });
        },
      }));

    // Deep link to a page plugin while the list is down: the router falls back to the dashboard.
    globalThis.history.replaceState({}, '', '/my-page');
    appState.ready = true;
    render(true, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', {status: 404})),
    });

    await vi.waitFor(() => expect(target.querySelector('.mndw-dashboard-page')).not.toBeNull());

    retryButton(target)?.click();

    await vi.waitFor(() => expect(target.querySelector('.mndw-page-plugin')).not.toBeNull(), {
      timeout: 5000,
    });
    expect(createPageInstance).toHaveBeenCalledTimes(1);
  });

  it('re-announces the alert when a retry fails again', async () => {
    vi.mocked(initAuthenticated).mockImplementation(async () => {
      appState.authInitInFlight = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      appState.pluginLoadError = 'list';
      appState.authInitInFlight = false;

      return getAuthRunGeneration();
    });
    appState.ready = true;
    render(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')).not.toBeNull();
    });

    const firstAlert = target.querySelector('[role="alert"]');

    retryButton(target)?.click();

    await vi.waitFor(() => {
      const nextAlert = target.querySelector('[role="alert"]');
      expect(nextAlert).not.toBeNull();
      expect(nextAlert).not.toBe(firstAlert);
    });
  });

  it('moves focus to the new retry button after a repeated failure remounts the alert', async () => {
    vi.mocked(initAuthenticated).mockImplementation(async () => {
      appState.authInitInFlight = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      appState.pluginLoadError = 'list';
      appState.authInitInFlight = false;

      return getAuthRunGeneration();
    });
    appState.ready = true;
    render(true);

    await vi.waitFor(() => {
      expect(retryButton(target)).not.toBeNull();
    });

    const retryButtonEl = target.querySelector<HTMLElement>('.mndw-plugin-load-alert mndw-button');
    const innerButton = retryButtonEl?.shadowRoot?.querySelector<HTMLButtonElement>('button');
    expect(innerButton).not.toBeNull();
    innerButton?.focus();
    expect([innerButton, retryButtonEl]).toContain(document.activeElement);

    retryButtonEl?.click();

    await vi.waitFor(() => {
      const nextButton = target.querySelector<HTMLElement>('.mndw-plugin-load-alert mndw-button');
      const nextInner = nextButton?.shadowRoot?.querySelector<HTMLButtonElement>('button');
      expect(nextInner).not.toBeNull();
      expect(nextInner).not.toBe(innerButton);
      expect([nextInner, nextButton]).toContain(document.activeElement);
    });
  });

  it('does not remount the shell when a retry is superseded by logout and re-login', async () => {
    const actual = await vi.importActual<typeof import('./services/init-auth.js')>('./services/init-auth.js');

    let callIndex = 0;
    let signalStaleLoadStarted: () => void = () => {};
    const staleLoadStarted = new Promise<void>((resolve) => {
      signalStaleLoadStarted = resolve;
    });
    let finishStaleLoad: () => void = () => {};
    const staleLoad = new Promise<void>((resolve) => {
      finishStaleLoad = resolve;
    });

    vi.mocked(initAuthenticated).mockImplementation(async (retryServices, deps) => {
      const isRetry = callIndex === 0;
      callIndex += 1;

      return actual.initAuthenticated(retryServices, {
        ...deps,
        loadPlugins: isRetry
          ? () => {
            signalStaleLoadStarted();

            return staleLoad;
          }
          : async (loaderDeps) => {
            await loadPlugins({
              ...loaderDeps,
              fetchList: async () => [],
              importModule: async () => ({createInstance: () => ({unmount() {}})}),
              loadStylesheet: async () => {},
              checkVersions: () => [],
            });
          },
      });
    });

    appState.ready = true;
    render(true, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', {status: 404})),
    });

    await vi.waitFor(() => {
      expect(retryButton(target)).not.toBeNull();
    });

    retryButton(target)?.click();
    await staleLoadStarted;

    // Log out and log back in while the retry is still parked on the plugin list.
    resetToLogin();
    appState.authenticated = true;
    await initAuthenticated(services, {});
    await vi.waitFor(() => expect(appState.ready).toBe(true), {timeout: 5000});

    const shellBefore = target.querySelector('.mndw-app-shell');
    const revisionBefore = appState.pluginLoadRevision;

    // The stale retry settles after the new init finished; it must not remount the shell.
    finishStaleLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(appState.pluginLoadRevision).toBe(revisionBefore);
    expect(target.querySelector('.mndw-app-shell')).toBe(shellBefore);
  });

  it('clears the previous list error when logout returns to login', async () => {
    appState.ready = true;
    render(true);

    await vi.waitFor(() => {
      expect(target.querySelector('[role="alert"]')).not.toBeNull();
    });

    resetToLogin();
    appState.authenticated = true;
    flushSync();

    expect(target.querySelector('[role="alert"]')).toBeNull();
  });

  it('disables retry while authenticated initialization is in flight', async () => {
    appState.authInitInFlight = true;
    appState.ready = true;
    render(true);

    await vi.waitFor(() => {
      expect(retryButton(target)).not.toBeNull();
    });

    const button = retryButton(target);

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });
});
