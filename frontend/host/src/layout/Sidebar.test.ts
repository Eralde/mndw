// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const mobileState = vi.hoisted(() => {
  const state: {
    matches: boolean;
    listener: ((event: MediaQueryListEvent) => void) | undefined;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  } = {
    matches: false,
    listener: undefined,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  state.addEventListener.mockImplementation((_event: string, listener: (event: MediaQueryListEvent) => void) => {
    state.listener = listener;
  });
  state.removeEventListener.mockImplementation(() => {
    state.listener = undefined;
  });

  return state;
});

vi.mock('./breakpoint.js', () => ({
  mobileMediaQuery: vi.fn(() => mobileState),
}));

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {getPages: vi.fn(() => [])},
}));

import {type LoadedPage, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry} from '../runtime/plugin-types.js';
import {setLocale} from '../services/locale.service.js';
import {appState} from '../state/app.svelte.js';
import Sidebar from './Sidebar.svelte';
import {defaultHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';

const emptyBackend = {routes: {}};

function page(name: string, label: string, route: string): LoadedPage {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'page',
    route,
  };

  return {entry, module: {createInstance: vi.fn()}};
}

function mountSidebar(): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(Sidebar, {target, context: createHostServicesContext(defaultHostServices())});

  flushSync();

  return {component, target};
}

function links(target: HTMLElement): {text: string; href: string}[] {
  return [...target.querySelectorAll<HTMLAnchorElement>('.mndw-sidebar__link')].map((a) => ({
    text: a.textContent?.trim() ?? '',
    href: a.getAttribute('href') ?? '',
  }));
}

function activeHrefs(target: HTMLElement): string[] {
  return [...target.querySelectorAll<HTMLAnchorElement>('.mndw-sidebar__link[aria-current="page"]')]
    .map((a) => a.getAttribute('href') ?? '');
}

describe('Sidebar', () => {
  beforeEach(() => {
    mobileState.matches = false;
    mobileState.listener = undefined;
    mobileState.addEventListener.mockClear();
    mobileState.removeEventListener.mockClear();
    appState.mobileSidebarOpen = false;
    appState.desktopSidebarCollapsed = false;
    appState.locale = 'en';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
    appState.mobileSidebarOpen = false;
    appState.desktopSidebarCollapsed = false;
    appState.locale = 'en';
  });

  describe('with page plugins', () => {
    beforeEach(() => {
      vi.mocked(pluginRegistry).getPages.mockReturnValue([
        page('zeta', 'Traffic', '/traffic'),
        page('beta-status', 'Status', '/beta-status'),
        page('alpha-status', 'Status', '/alpha-status'),
      ]);
    });

    it('keeps Dashboard first, Entware second, sorts plugin links, and Settings last', () => {
      const {component, target} = mountSidebar();

      expect(links(target)).toEqual([
        {text: 'Dashboard', href: '/'},
        {text: 'Entware', href: '/packages'},
        {text: 'Status', href: '/alpha-status'},
        {text: 'Status', href: '/beta-status'},
        {text: 'Traffic', href: '/traffic'},
        {text: 'Settings', href: '/settings'},
      ]);

      void unmount(component);
    });

    it('renders the Plugins section heading', () => {
      const {component, target} = mountSidebar();

      expect(target.querySelector('.mndw-sidebar__section-label')?.textContent).toBe('Plugins');

      void unmount(component);
    });

    it('updates navigation labels after a locale commit', async () => {
      const {component, target} = mountSidebar();

      await setLocale('ru');
      flushSync();

      expect(appState.locale).toBe('ru');
      expect(links(target).map(({text}) => text)).toEqual([
        'Панель управления',
        'Entware',
        'Status',
        'Status',
        'Traffic',
        'Настройки',
      ]);

      void unmount(component);
    });
  });

  describe('without page plugins', () => {
    beforeEach(() => {
      vi.mocked(pluginRegistry).getPages.mockReturnValue([]);
    });

    it('omits the Plugins heading and shows only Dashboard, Entware and Settings', () => {
      const {component, target} = mountSidebar();

      expect(target.querySelector('.mndw-sidebar__section-label')).toBeNull();
      expect(links(target)).toEqual([
        {text: 'Dashboard', href: '/'},
        {text: 'Entware', href: '/packages'},
        {text: 'Settings', href: '/settings'},
      ]);

      void unmount(component);
    });

    it('marks only Dashboard active at the root route', () => {
      window.history.replaceState(null, '', '/');

      const {component, target} = mountSidebar();

      expect(activeHrefs(target)).toEqual(['/']);
      expect(target.querySelector('a[href="/"]')?.classList.contains('active')).toBe(true);

      void unmount(component);
    });

    it('marks Settings active for a nested settings route', () => {
      window.history.replaceState(null, '', '/settings/plugins');

      const {component, target} = mountSidebar();

      expect(activeHrefs(target)).toEqual(['/settings']);
      expect(target.querySelector('a[href="/settings"]')?.classList.contains('active')).toBe(true);

      void unmount(component);
    });

    it('does not mark Dashboard active for another route', () => {
      window.history.replaceState(null, '', '/packages');

      const {component, target} = mountSidebar();

      expect(activeHrefs(target)).toEqual(['/packages']);

      void unmount(component);
    });

    it('closes an open mobile drawer when its backdrop is clicked', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLElement>('.mndw-sidebar-backdrop')?.click();
      flushSync();

      expect(appState.mobileSidebarOpen).toBe(false);
      expect(target.querySelector('.mndw-sidebar-backdrop')).toBeNull();

      void unmount(component);
    });

    it('closes an open mobile drawer when any sidebar link is clicked', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLAnchorElement>('.mndw-sidebar__link')?.click();

      expect(appState.mobileSidebarOpen).toBe(false);

      void unmount(component);
    });

    it('keeps the drawer open when a sidebar link is clicked on desktop', () => {
      mobileState.matches = false;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLAnchorElement>('.mndw-sidebar__link')?.click();

      expect(appState.desktopSidebarCollapsed).toBe(false);

      void unmount(component);
    });

    it('renders the backdrop as a sibling of the sidebar nav', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const {component, target} = mountSidebar();

      const backdrop = target.querySelector('.mndw-sidebar-backdrop');
      const nav = target.querySelector('.mndw-sidebar');

      expect(backdrop?.parentElement).toBe(target);
      expect(nav?.parentElement).toBe(target);
      expect(backdrop?.nextElementSibling).toBe(nav);

      void unmount(component);
    });

    it('renders the backdrop as presentation, not a button', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const {component, target} = mountSidebar();
      const backdrop = target.querySelector('.mndw-sidebar-backdrop');

      expect(backdrop?.getAttribute('role')).toBe('presentation');
      expect(backdrop?.hasAttribute('tabindex')).toBe(false);
      void unmount(component);
    });

    it('closes the open mobile drawer on Escape', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const {component} = mountSidebar();

      window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      flushSync();

      expect(appState.mobileSidebarOpen).toBe(false);
      void unmount(component);
    });

    it('keeps focus inside the open mobile drawer', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const outside = document.createElement('button');

      document.body.appendChild(outside);

      const {component, target} = mountSidebar();

      flushSync();
      outside.focus();

      expect(target.querySelector('.mndw-sidebar')?.contains(document.activeElement)).toBe(true);
      void unmount(component);
      outside.remove();
    });

    it('does not trap focus on desktop', () => {
      mobileState.matches = false;

      const outside = document.createElement('button');

      document.body.appendChild(outside);

      const {component} = mountSidebar();

      outside.focus();

      expect(document.activeElement).toBe(outside);
      void unmount(component);
      outside.remove();
    });

    it('keeps the same nav element across open and close so the slide transition plays', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = false;

      const {component, target} = mountSidebar();
      const closedNav = target.querySelector('.mndw-sidebar');

      appState.mobileSidebarOpen = true;
      flushSync();

      expect(target.querySelector('.mndw-sidebar')).toBe(closedNav);
      expect(closedNav?.classList.contains('mobile-collapsed')).toBe(false);
      void unmount(component);
    });

    it('makes the collapsed mobile nav inert and the open one interactive', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = false;

      const {component, target} = mountSidebar();
      const nav = target.querySelector('.mndw-sidebar');

      expect(nav?.hasAttribute('inert')).toBe(true);

      appState.mobileSidebarOpen = true;
      flushSync();
      expect(nav?.hasAttribute('inert')).toBe(false);

      void unmount(component);
    });

    it('never makes the desktop nav inert', () => {
      mobileState.matches = false;
      appState.desktopSidebarCollapsed = false;

      const {component, target} = mountSidebar();

      expect(target.querySelector('.mndw-sidebar')?.hasAttribute('inert')).toBe(false);
      void unmount(component);
    });

    it('moves focus to the first nav link when the mobile drawer opens', async () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = false;

      const toggle = document.createElement('button');

      document.body.appendChild(toggle);
      toggle.focus();

      const {component, target} = mountSidebar();

      appState.mobileSidebarOpen = true;
      flushSync();
      await Promise.resolve();

      const nav = target.querySelector('.mndw-sidebar');

      expect(nav?.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(nav?.querySelector('a.mndw-sidebar__link'));

      appState.mobileSidebarOpen = false;
      flushSync();
      expect(document.activeElement).toBe(toggle);

      void unmount(component);
      toggle.remove();
    });

    it('returns focus to the menu toggle when a drawer link closes it', async () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = false;

      const toggle = document.createElement('button');

      document.body.appendChild(toggle);
      toggle.focus();

      const {component, target} = mountSidebar();

      appState.mobileSidebarOpen = true;
      flushSync();
      await Promise.resolve();

      const link = target.querySelector<HTMLAnchorElement>('.mndw-sidebar__link');

      link?.focus();
      link?.click();
      flushSync();

      expect(document.activeElement).toBe(toggle);
      void unmount(component);
      toggle.remove();
    });

    it('does not leak mobile drawer closure into desktop presentation', () => {
      mobileState.matches = true;
      appState.mobileSidebarOpen = true;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLElement>('.mndw-sidebar-backdrop')?.click();
      flushSync();
      mobileState.listener?.({matches: false} as MediaQueryListEvent);
      flushSync();

      expect(appState.mobileSidebarOpen).toBe(false);
      expect(appState.desktopSidebarCollapsed).toBe(false);
      expect(target.querySelector('.mndw-sidebar')?.classList.contains('collapsed')).toBe(false);
      expect(target.querySelector('.mndw-sidebar')?.classList.contains('mobile-collapsed')).toBe(false);

      void unmount(component);
    });
  });

  it('marks a plugin parent active for a nested plugin route', () => {
    vi.mocked(pluginRegistry).getPages.mockReturnValue([
      page('traffic', 'Traffic', '/traffic'),
    ]);
    window.history.replaceState(null, '', '/traffic/details');

    const {component, target} = mountSidebar();

    expect(activeHrefs(target)).toEqual(['/traffic']);
    expect(target.querySelector('a[href="/traffic"]')?.classList.contains('active')).toBe(true);

    void unmount(component);
  });
});
