import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import IperfWidget from './IperfWidget.svelte';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  if (context.kind !== 'widget') {
    throw new Error('iperf-widget requires a widget context');
  }

  const app = mount(IperfWidget, {
    target: container,
    props: {context},
  });

  return {
    async unmount(): Promise<void> {
      await unmount(app);
    },
  };
}
