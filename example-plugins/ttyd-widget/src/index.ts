import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import TtydWidget from './TtydWidget.svelte';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(TtydWidget, {target: el, props: {backend: ctx.backend}});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
