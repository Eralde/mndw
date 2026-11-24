import type {PluginContext, Translator} from '@mndw/sdk';
import {createApp} from 'vue';
import ColumnSettings from '../components/ColumnSettings.vue';
import type {RssiThresholds} from '../components/rssi.js';

export interface SettingsDialogOptions {
  visibility: Record<string, boolean>;
  refreshIntervalSeconds: number;
  rssiThresholds: RssiThresholds;
  onColumnChange: (key: string, value: boolean) => void;
  onRefreshIntervalChange: (value: number) => void;
  onRssiThresholdsChange: (value: RssiThresholds) => void;
  translator: Translator;
}

export function openSettingsDialog(ctx: PluginContext, options: SettingsDialogOptions): void {
  ctx.overlay.open({
    kind: 'modal',
    title: options.translator.t('settings'),
    width: 280,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = createApp(
        ColumnSettings,
        {
          visibility: options.visibility,
          refreshIntervalSeconds: options.refreshIntervalSeconds,
          rssiThresholds: options.rssiThresholds,
          onChange: options.onColumnChange,
          onRefreshIntervalChange: options.onRefreshIntervalChange,
          onRssiThresholdsChange: options.onRssiThresholdsChange,
          translator: options.translator,
        },
      );

      app.mount(target);
      layer.setCleanup(() => app.unmount());
    },
  });
}
