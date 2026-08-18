import {type ApplicationRef, type EnvironmentInjector, createComponent} from '@angular/core';
import type {PluginContext} from '@mndw/sdk';
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
  injector: EnvironmentInjector,
  args: SettingsDialogArgs,
): void {
  ctx.overlay.open({
    kind: 'modal',
    title: args.title,
    closeOnOutsideClick: true,
    mount(target, layer) {
      const ref = createComponent(
        SettingsDialogComponent,
        {
          hostElement: target,
          environmentInjector: injector,
        },
      );

      ref.setInput('interfaces', args.interfaces);
      ref.setInput('selectedInterface', args.selectedInterface);
      ref.setInput('refresh', args.refresh);

      const subscriptions = [
        ref.instance.interfaceChange.subscribe((id: string) => args.onInterfaceChange(id)),
        ref.instance.refreshChange.subscribe((refresh: number) => args.onRefreshChange(refresh)),
        ref.instance.closeDialogEvent.subscribe(() => layer.close(undefined, 'action')),
      ];

      appRef.attachView(ref.hostView);

      layer.setCleanup(() => {
        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }

        appRef.detachView(ref.hostView);
        ref.destroy();
      });
    },
  });
}
