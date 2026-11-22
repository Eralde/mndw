import {mount, unmount} from 'svelte';
import type {PluginContext, Translator} from '@mndw/sdk';
import type {Settings} from '../model/settings.js';
import SettingsDialog from '../components/SettingsDialog.svelte';

export function openSettingsDialog(
  context: PluginContext,
  settings: Settings,
  translator: Translator,
  onSave: (settings: Settings) => Promise<void>,
): void {
  context.overlay.open({
    kind: 'modal',
    title: translator.t('settings.title'),
    width: 'min(32rem, calc(100vw - 2rem))',
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = mount(SettingsDialog, {
        target,
        props: {
          initialSettings: settings,
          translator,
          onSave: async (next: Settings): Promise<void> => {
            await onSave(next);
            layer.close(undefined, 'action');
          },
          onCancel: () => layer.close(),
        },
      });

      layer.setCleanup(() => {
        void unmount(app);
      });
    },
  });
}
