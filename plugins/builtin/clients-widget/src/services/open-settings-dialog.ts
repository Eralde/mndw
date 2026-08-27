import type {PluginContext, Translator} from '@mndw/sdk';
import {createApp} from 'vue';
import ColumnSettings from '../components/ColumnSettings.vue';

export function openSettingsDialog(
  ctx: PluginContext,
  visibility: Record<string, boolean>,
  refreshIntervalSeconds: number,
  onChange: (key: string, value: boolean) => void,
  onRefreshIntervalChange: (value: number) => void,
  translator: Translator,
): void {
  ctx.overlay.open({
    kind: 'modal',
    title: translator.t('settings'),
    width: 280,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = createApp(
        ColumnSettings,
        {
          visibility,
          refreshIntervalSeconds,
          onChange,
          onRefreshIntervalChange,
          translator,
        },
      );

      app.mount(target);
      layer.setCleanup(() => app.unmount());
    },
  });
}
