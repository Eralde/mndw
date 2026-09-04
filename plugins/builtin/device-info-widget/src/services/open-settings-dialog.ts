import type {PluginContext, Translator} from '@mndw/sdk';
import {createApp} from 'vue';
import SectionSettings from '../components/SectionSettings.vue';

export function openSettingsDialog(
  ctx: PluginContext,
  visibility: Record<string, boolean>,
  onChange: (key: string, value: boolean) => void,
  translator: Translator,
): void {
  ctx.overlay.open({
    kind: 'modal',
    title: translator.t('settings'),
    width: 280,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = createApp(SectionSettings, {visibility, onChange, translator});

      app.mount(target);
      layer.setCleanup(() => app.unmount());
    },
  });
}
