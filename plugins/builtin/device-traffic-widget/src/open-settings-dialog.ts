import {mount, unmount} from 'svelte';
import type {PluginContext} from '@mndw/sdk';
import SettingsForm from './components/SettingsForm.svelte';
import type {HostClient} from './types.js';

export interface OpenSettingsArgs {
  hosts: HostClient[];
  selectedMac: string;
  onSelect: (mac: string) => void;
}

/**
 * Opens the device picker as a host-managed centered modal via `ctx.overlay.open()`.
 * The host renders the dialog chrome (title, close button, backdrop) and owns
 * stacking, focus, scroll lock, and dismissal; this helper only mounts the Svelte
 * form into the host-provided shell body and registers teardown.
 */
export function openSettingsDialog(ctx: PluginContext, args: OpenSettingsArgs): void {
  ctx.overlay.open({
    kind: 'modal',
    title: 'Select Device',
    width: 360,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const app = mount(SettingsForm, {
        target,
        props: {
          hosts: args.hosts,
          selectedMac: args.selectedMac,
          onSelect: (mac: string) => {
            args.onSelect(mac);
            layer.close(undefined, 'action');
          },
          onClose: () => layer.close(undefined, 'action'),
        },
      });

      layer.setCleanup(() => {
        void unmount(app);
      });
    },
  });
}
