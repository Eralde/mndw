import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const mobileState = vi.hoisted(() => ({matches: false}));

vi.mock('./breakpoint.js', () => ({
  mobileMediaQuery: vi.fn(() => ({matches: mobileState.matches})),
}));

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {getPages: vi.fn(() => [])},
}));

import {type LoadedPage, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry} from '../runtime/plugin-types.js';
import {setLocale} from '../services/locale.service.js';
import {appState} from '../state/app.svelte.js';
import Sidebar from './Sidebar.svelte';

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

  const component = mount(Sidebar, {target});

  flushSync();

  return {component, target};
}

function links(target: HTMLElement): {text: string; href: string}[] {
  return [...target.querySelectorAll<HTMLAnchorElement>('.mndw-sidebar__link')].map((a) => ({
    text: a.textContent?.trim() ?? '',
    href: a.getAttribute('href') ?? '',
  }));
}

describe('Sidebar', () => {
  beforeEach(() => {
    mobileState.matches = false;
    appState.sidebarCollapsed = false;
    appState.locale = 'en';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    appState.sidebarCollapsed = false;
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

    it('keeps Dashboard first, Package Manager second, sorts plugin links, and Settings last', () => {
      const {component, target} = mountSidebar();

      expect(links(target)).toEqual([
        {text: 'Dashboard', href: '/'},
        {text: 'Package Manager', href: '/packages'},
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
        'Менеджер пакетов',
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

    it('omits the Plugins heading and shows only Dashboard, Package Manager and Settings', () => {
      const {component, target} = mountSidebar();

      expect(target.querySelector('.mndw-sidebar__section-label')).toBeNull();
      expect(links(target)).toEqual([
        {text: 'Dashboard', href: '/'},
        {text: 'Package Manager', href: '/packages'},
        {text: 'Settings', href: '/settings'},
      ]);

      void unmount(component);
    });

    it('closes an open mobile drawer when its backdrop is clicked', () => {
      mobileState.matches = true;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLElement>('.mndw-sidebar-backdrop')?.click();
      flushSync();

      expect(appState.sidebarCollapsed).toBe(true);
      expect(target.querySelector('.mndw-sidebar-backdrop')).toBeNull();

      void unmount(component);
    });

    it('closes an open mobile drawer when any sidebar link is clicked', () => {
      mobileState.matches = true;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLAnchorElement>('.mndw-sidebar__link')?.click();

      expect(appState.sidebarCollapsed).toBe(true);

      void unmount(component);
    });

    it('keeps the drawer open when a sidebar link is clicked on desktop', () => {
      mobileState.matches = false;

      const {component, target} = mountSidebar();

      target.querySelector<HTMLAnchorElement>('.mndw-sidebar__link')?.click();

      expect(appState.sidebarCollapsed).toBe(false);

      void unmount(component);
    });

    it('renders the backdrop as a sibling of the sidebar nav', () => {
      mobileState.matches = true;

      const {component, target} = mountSidebar();

      const backdrop = target.querySelector('.mndw-sidebar-backdrop');
      const nav = target.querySelector('.mndw-sidebar');

      expect(backdrop?.parentElement).toBe(target);
      expect(nav?.parentElement).toBe(target);
      expect(backdrop?.nextElementSibling).toBe(nav);

      void unmount(component);
    });
  });
});
