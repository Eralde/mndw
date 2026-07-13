import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import PingWidget from './PingWidget.svelte';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  const app = mount(PingWidget, {target: container, props: {backend: context.backend}});

  return {
    unmount(): void {
      void unmount(app);
    },
  };
}
