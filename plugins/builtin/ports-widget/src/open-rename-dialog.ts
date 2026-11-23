import {mount, unmount} from 'svelte';
import type {PluginContext, Translator} from '@mndw/sdk';
import RenameDialog from './components/RenameDialog.svelte';

export function openRenameDialog(
  context: PluginContext,
  label: string,
  description: string | null,
  translator: Translator,
  onsave: (value: string | null) => Promise<string | null>,
): void {
  context.overlay.open({
    kind: 'modal',
    title: translator.t('details.renameTitle', {label}),
    width: 360,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = mount(RenameDialog, {
        target,
        props: {
          description,
          translator,
          onsave,
          onclose: () => layer.close(undefined, 'action'),
        },
      });

      layer.setCleanup(() => unmount(app));
    },
  });
}
