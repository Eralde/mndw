import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import PortsWidget from './PortsWidget.svelte';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  const app = mount(PortsWidget, {
    target: container,
    props: {context},
  });
  const unsubscribeLocale = bindLocale(context.i18n, () => {
    if (context.kind === 'widget') {
      context.setTileTitle(context.i18n.t('title'));
    }
  });

  return {
    async unmount(): Promise<void> {
      unsubscribeLocale();
      await unmount(app);
    },
  };
}
