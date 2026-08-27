import type {ApplicationRef} from '@angular/core';
import type {PluginContext} from '@mndw/sdk';
import {mountComponentInOverlay} from '@mndw/sdk/angular';
import type {NetworkInterface} from './types/rci.types';
import {SettingsDialogComponent} from './components/settings-dialog/settings-dialog.component';

export interface SettingsDialogArgs {
  title: string;
  interfaces: NetworkInterface[];
  selectedInterface: string;
  refresh: number;
  onInterfaceChange: (interfaceId: string) => void;
  onRefreshChange: (refresh: number) => void;
}

export type OpenSettingsFn = (args: SettingsDialogArgs) => void;

/**
 * Opens the settings form in a host-managed modal via `ctx.overlay.open()`.
 * The dialog component is created directly into the host-provided shell body with
 * the shared Angular `EnvironmentInjector`; the host never re-parents its DOM.
 */
export function openSettingsDialog(
  ctx: PluginContext,
  appRef: ApplicationRef,
  args: SettingsDialogArgs,
): void {
  ctx.overlay.open({
    kind: 'modal',
    title: args.title,
    closeOnOutsideClick: true,
    mount(target, layer) {
      mountComponentInOverlay({
        appRef,
        target,
        layer,
        component: SettingsDialogComponent,
        setup: (ref) => {
          ref.setInput('interfaces', args.interfaces);
          ref.setInput('selectedInterface', args.selectedInterface);
          ref.setInput('refresh', args.refresh);

          const subscriptions = [
            ref.instance.interfaceChange.subscribe((id: string) => args.onInterfaceChange(id)),
            ref.instance.refreshChange.subscribe((refresh: number) => args.onRefreshChange(refresh)),
            ref.instance.closeDialogEvent.subscribe(() => layer.close(undefined, 'action')),
          ];

          return () => {
            for (const subscription of subscriptions) {
              subscription.unsubscribe();
            }
          };
        },
      });
    },
  });
}
