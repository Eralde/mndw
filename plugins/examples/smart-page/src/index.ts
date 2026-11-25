import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import SmartPage from './SmartPage.svelte';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  if (context.kind !== 'page') {
    throw new Error('smart-page requires a page context');
  }

  const app = mount(SmartPage, {
    target: container,
    props: {context},
  });

  return {
    async unmount(): Promise<void> {
      await unmount(app);
    },
  };
}
