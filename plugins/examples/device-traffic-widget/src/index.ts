import {mount, unmount} from 'svelte';
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import TrafficWidget from './components/TrafficWidget.svelte';
import {type OpenSettingsArgs, openSettingsDialog} from './open-settings-dialog.js';

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(TrafficWidget, {
    target: container,
    props: {
      rci: ctx.device.rci,
      storage: ctx.storage.instance,
      timers: ctx.timers,
      openSettings: (args: OpenSettingsArgs) => openSettingsDialog(ctx, args),
      setTileTitle: ctx.setTileTitle,
      i18n: ctx.i18n,
    },
  });

  return {
    unmount() {
      void unmount(app);
    },
  };
}
