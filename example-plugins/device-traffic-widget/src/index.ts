import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import TrafficWidget from './components/TrafficWidget.svelte';
import {type OpenSettingsArgs, openSettingsDialog} from './open-settings-dialog.js';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(TrafficWidget, {
    target: container,
    props: {
      rci: ctx.rciManager,
      storage: ctx.storage,
      openSettings: (args: OpenSettingsArgs) => openSettingsDialog(ctx, args),
      setTileTitle: ctx.setTileTitle,
    },
  });

  return {
    unmount() {
      void unmount(app);
    },
  };
}
