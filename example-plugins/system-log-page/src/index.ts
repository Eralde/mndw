import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import SystemLogPage from './SystemLogPage.svelte';
import {createSystemLogApi} from './system-log-api';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const api = createSystemLogApi(ctx.rciManager);
  const app = mount(SystemLogPage, {target: el, props: {api, overlay: ctx.overlay}});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
