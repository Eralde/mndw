import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {getPages: vi.fn(() => [])},
}));

import {type LoadedPage, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry} from '../runtime/plugin-types.js';
import Sidebar from './Sidebar.svelte';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function page(name: string, label: string, route: string): LoadedPage {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
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
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  describe('with page plugins', () => {
    beforeEach(() => {
      vi.mocked(pluginRegistry).getPages.mockReturnValue([
        page('zeta', 'Traffic', '/traffic'),
        page('beta-status', 'Status', '/beta-status'),
        page('alpha-status', 'Status', '/alpha-status'),
      ]);
    });

    it('keeps Dashboard first, sorts plugin links by label then name, and Settings last', () => {
      const {component, target} = mountSidebar();

      expect(links(target)).toEqual([
        {text: 'Dashboard', href: '/'},
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
  });

  describe('without page plugins', () => {
    beforeEach(() => {
      vi.mocked(pluginRegistry).getPages.mockReturnValue([]);
    });

    it('omits the Plugins heading and shows only Dashboard and Settings', () => {
      const {component, target} = mountSidebar();

      expect(target.querySelector('.mndw-sidebar__section-label')).toBeNull();
      expect(links(target)).toEqual([
        {text: 'Dashboard', href: '/'},
        {text: 'Settings', href: '/settings'},
      ]);

      void unmount(component);
    });
  });
});
