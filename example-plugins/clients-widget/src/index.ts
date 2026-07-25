import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createApp} from 'vue';
import App from './App.vue';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = createApp(App, {ctx});

  app.mount(container);

  return {
    unmount() {
      app.unmount();
    },
  };
}
