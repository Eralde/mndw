import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import App from './App.svelte';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {rci: ctx.device.rci, i18n: ctx.i18n}});
  const unsubscribeLocale = bindLocale(ctx.i18n, () => {
    if (ctx.kind === 'widget') {
      ctx.setTileTitle?.(ctx.i18n.t('title'));
    }
  });

  return {
    unmount(): void {
      unsubscribeLocale();
      void unmount(app);
    },
  };
}
