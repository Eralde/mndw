import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import TerminalPage from './TerminalPage.svelte';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(TerminalPage, {target: el, props: {backend: ctx.backend}});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
