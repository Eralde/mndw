import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createApp} from 'vue';
import {bindLocale} from '@mndw/sdk/bind-locale';

import App from './App.vue';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = createApp(App, {ctx});

  app.mount(container);
  const unsubscribeLocale = bindLocale(ctx.i18n, () => {
    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(ctx.i18n.t('l10n.title'));
    }
  });

  return {
    unmount() {
      unsubscribeLocale();
      app.unmount();
    },
  };
}
