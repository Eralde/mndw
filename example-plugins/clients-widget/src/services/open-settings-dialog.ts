import type {PluginContext} from '@mndw/sdk';
import {createApp} from 'vue';
import ColumnSettings from '../components/ColumnSettings.vue';

export function openSettingsDialog(
  ctx: PluginContext,
  visibility: Record<string, boolean>,
  refreshIntervalSeconds: number,
  onChange: (key: string, value: boolean) => void,
  onRefreshIntervalChange: (value: number) => void,
): void {
  ctx.overlay.open({
    kind: 'modal',
    title: 'Client settings',
    width: 280,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = createApp(ColumnSettings, {
        visibility,
        refreshIntervalSeconds,
        onChange,
        onRefreshIntervalChange,
      });

      app.mount(target);
      layer.setCleanup(() => app.unmount());
    },
  });
}
