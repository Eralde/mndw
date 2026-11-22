import {mount, unmount} from 'svelte';
import type {PluginContext, Translator} from '@mndw/sdk';
import type {HistoryEntry} from '../model/history.js';
import HistoryDialog from '../components/HistoryDialog.svelte';

export function openHistoryDialog(
  context: PluginContext,
  history: readonly HistoryEntry[],
  translator: Translator,
): void {
  context.overlay.open({
    kind: 'modal',
    title: translator.t('history.title'),
    width: 'min(42rem, calc(100vw - 2rem))',
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = mount(HistoryDialog, {
        target,
        props: {history, translator, onClose: () => layer.close()},
      });

      layer.setCleanup(() => {
        void unmount(app);
      });
    },
  });
}
