import {mount, unmount} from 'svelte';
import type {PluginContext, Translator} from '@mndw/sdk';
import type {WidgetSettings} from './model/settings.js';
import SettingsDialog from './components/SettingsDialog.svelte';

export function openSettingsDialog(
  context: PluginContext,
  settings: WidgetSettings,
  translator: Translator,
  onchange: (settings: WidgetSettings) => void,
): void {
  context.overlay.open({
    kind: 'modal',
    title: translator.t('settings.title'),
    width: 360,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = mount(SettingsDialog, {target, props: {settings, translator, onchange}});

      layer.setCleanup(() => unmount(app));
    },
  });
}
