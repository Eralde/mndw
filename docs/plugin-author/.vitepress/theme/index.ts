import {h} from 'vue';
import DefaultTheme from 'vitepress/theme';
import type {Theme} from 'vitepress';

import './custom.css';
import HomeHero from './components/HomeHero.vue';
import SidebarFooter from './components/SidebarFooter.vue';
import {SIDEBAR_TOGGLE_EVENT, toggleSidebar} from './sidebar-toggle';

const theme: Theme = {
  extends: DefaultTheme,
  // VitePress resolves its Vue peer at runtime; the root TS project cannot resolve that nested peer for `h()`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  Layout: () => h(DefaultTheme.Layout, null, {'sidebar-nav-after': () => h(SidebarFooter)}),
  enhanceApp({app}) {
    app.component('HomeHero', HomeHero);

    if (typeof window !== 'undefined') {
      window.addEventListener(SIDEBAR_TOGGLE_EVENT, () => {
        toggleSidebar(document);
      });
    }
  },
};

export default theme;
