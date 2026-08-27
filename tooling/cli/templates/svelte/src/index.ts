import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';

import App from './App.svelte';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {ctx}});

  return {
    unmount() {
      void unmount(app);
    },
  };
}
