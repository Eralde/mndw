import {h} from 'vue';
import DefaultTheme from 'vitepress/theme';
import type {Theme} from 'vitepress';

import '@mndw/sdk/tokens.css';
import '@mndw/ui/styles.css';

import './custom.css';
import HomeHero from './components/HomeHero.vue';
import SidebarFooter from './components/SidebarFooter.vue';
import UiCatalog from './components/UiCatalog.vue';
import UiHtmlDemo from './components/UiHtmlDemo.vue';
import UiScriptDemo from './components/UiScriptDemo.vue';
import {SIDEBAR_TOGGLE_EVENT, toggleSidebar} from './sidebar-toggle';
import {syncMndwTheme} from './ui-theme-sync';

const theme: Theme = {
  extends: DefaultTheme,
  // VitePress resolves its Vue peer at runtime; the root TS project cannot resolve that nested peer for `h()`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  Layout: () => h(DefaultTheme.Layout, null, {'sidebar-nav-after': () => h(SidebarFooter)}),
  enhanceApp({app}) {
    app.component('HomeHero', HomeHero);
    app.component('UiCatalog', UiCatalog);
    app.component('UiHtmlDemo', UiHtmlDemo);
    app.component('UiScriptDemo', UiScriptDemo);

    if (typeof window !== 'undefined') {
      void Promise.all([
        import('@mndw/ui'),
        import('@mndw/ui/icons.svg?url&no-inline'),
        import('../../../../frontend/host/src/services/overlay/standalone-overlay'),
      ]).then(([ui, iconSprite, standaloneOverlay]) => {
        const overlayContainer = document.createElement('div');

        document.body.appendChild(overlayContainer);

        const {service} = standaloneOverlay.mountStandaloneOverlay(overlayContainer);

        ui.defineMndwUi({
          overlay: service,
          iconSpriteUrl: (iconSprite as {default: string}).default,
          initialLocale: 'en',
        });
      })
        .catch((error: unknown) => {
          console.error('[mndw] Failed to initialize UI playground components and host overlay.', error);
        });

      syncMndwTheme(document);
      window.addEventListener(SIDEBAR_TOGGLE_EVENT, () => {
        toggleSidebar(document);
      });
    }
  },
};

export default theme;
