// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MndwPlugin} from '@mndw/sdk';
import App from './App.svelte';
import {createHostServices} from './host-services.js';
import type {PageListEntry} from './runtime/plugin-types.js';
import {appState} from './state/app.svelte.js';

type MndwSelectElement = HTMLElement & {
  open: boolean;
  updateComplete: Promise<unknown>;
};

let target: HTMLDivElement;
let component: ReturnType<typeof mount>;
let services: ReturnType<typeof createHostServices>;

function render(hostServices = createHostServices()): void {
  services = hostServices;
  target = document.createElement('div');
  document.body.appendChild(target);
  defineMndwUi({overlay: services.overlay, initialLocale: services.locale.getLocale()});
  component = mount(App, {target, props: {services}});
  flushSync();
}

function loginLocaleSelect(): MndwSelectElement {
  const select = target.querySelector<MndwSelectElement>('.mndw-login__locale-select');

  if (!select) {
    throw new Error('Login locale selector was not rendered');
  }

  return select;
}

function renderedSelectPanel(): Element | null {
  return document.querySelector('mndw-select-panel');
}

beforeEach(() => {
  appState.authenticated = false;
  appState.ready = false;
  appState.locale = 'en';
  appState.localeSwitchPending = false;
});

afterEach(() => {
  if (component !== undefined) {
    void unmount(component);
  }

  services?.registry.clear();
  document.body.innerHTML = '';
});

describe('App login overlays', () => {
  it('renders the login language options after a mouse click', async () => {
    render();

    const select = loginLocaleSelect();

    await select.updateComplete;

    select.dispatchEvent(new MouseEvent('click', {bubbles: true, composed: true}));
    flushSync();

    expect(select.open).toBe(true);
    expect(renderedSelectPanel()).not.toBeNull();
  });

  it('renders the login language options after keyboard activation', async () => {
    render();

    const select = loginLocaleSelect();

    await select.updateComplete;

    select.focus();
    select.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        composed: true,
      }),
    );
    flushSync();

    expect(select.open).toBe(true);
    expect(renderedSelectPanel()).not.toBeNull();
  });
});

describe('App loading state', () => {
  it('announces busy status while the authenticated shell is initializing', () => {
    appState.authenticated = true;
    appState.ready = false;
    render();

    const loading = target.querySelector('.mndw-loading');

    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('role')).toBe('status');
    expect(loading?.getAttribute('aria-busy')).toBe('true');
    expect(loading?.textContent?.trim()).toBe('Loading…');
  });
});

describe('App shell service graph', () => {
  it('switches host and mounted plugin language through the header', async () => {
    const hostServices = createHostServices();
    hostServices.locale.initLocale();
    const entry: PageListEntry = {
      name: 'locale-probe',
      version: '1.0.0',
      label: 'Locale probe',
      entry: 'index.js',
      source: 'builtin',
      approval: 'approved',
      enabled: true,
      depsStatus: 'ready',
      backend: {routes: {}},
      type: 'page',
      route: '/locale-probe',
    };
    const plugin: MndwPlugin = {
      createInstance: (container, context) => {
        const localeNode = document.createElement('span');
        localeNode.dataset.pluginLocale = '';
        container.appendChild(localeNode);
        const subscription = context.i18n.locale$.subscribe((locale) => {
          localeNode.textContent = locale;
        });

        return {unmount: () => subscription.unsubscribe()};
      },
    };

    hostServices.registry.register({entry, module: plugin});
    const router = hostServices.router.create(hostServices.registry);
    await router.navigate('/locale-probe');
    appState.authenticated = true;
    appState.ready = true;
    render(hostServices);

    const localeSelect = target.querySelector<HTMLElement>('.mndw-header__locale-select');

    expect(target.querySelector('.mndw-header__logout')?.textContent?.trim()).toBe('Log out');
    expect(target.querySelector('[data-plugin-locale]')?.textContent).toBe('en');
    localeSelect?.dispatchEvent(
      new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'ru'}}),
    );

    await vi.waitFor(() => {
      expect(target.querySelector('.mndw-header__logout')?.textContent?.trim()).toBe('Выйти');
      expect(appState.locale).toBe('ru');
      expect(target.querySelector('[data-plugin-locale]')?.textContent).toBe('ru');
    });
  });
});
