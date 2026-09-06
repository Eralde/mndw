import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import EventLogger from './EventLogger.svelte';

export function createInstance(container: HTMLElement, context: PluginContext): PluginInstance {
  const app = mount(EventLogger, {target: container, props: {events: context.events, i18n: context.i18n}});

  return {
    async unmount(): Promise<void> {
      await unmount(app);
    },
  };
}
