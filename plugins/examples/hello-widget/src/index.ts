import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import App from './App.svelte';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {backend: ctx.backend, i18n: ctx.i18n}});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
