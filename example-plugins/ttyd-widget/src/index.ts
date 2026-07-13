import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import TtydWidget from './TtydWidget.svelte';

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  const spawnEndpoint = ctx.backend?.endpoints.spawn?.path ?? '/api/plugins/ttyd-widget/spawn';
  const killEndpoint = ctx.backend?.endpoints.kill?.path ?? '/api/plugins/ttyd-widget/kill';
  const websocketPath = ctx.backend?.websockets.terminal?.path ?? '/ws/plugins/ttyd-widget/terminal';

  const app = mount(TtydWidget, {target: el, props: {spawnEndpoint, killEndpoint, websocketPath}});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
