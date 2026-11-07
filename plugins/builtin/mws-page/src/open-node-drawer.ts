import type {ApplicationRef} from '@angular/core';
import type {PluginContext} from '@mndw/sdk';
import {mountComponentInOverlay} from '@mndw/sdk/angular';
import {NodeDrawerComponent} from './components/node-drawer/node-drawer.component';
import type {NodeDetailsSource} from './node-details-source';

export function openNodeDrawer(
  ctx: PluginContext,
  appRef: ApplicationRef,
  source: NodeDetailsSource,
  nodeId: string,
  title: string,
  onClose: () => void = () => undefined,
): void {
  const opened = ctx.overlay.open({
    kind: 'drawer',
    title,
    width: 960,
    closeOnOutsideClick: true,
    mount(target, layer) {
      mountComponentInOverlay({
        appRef,
        target,
        layer,
        component: NodeDrawerComponent,
        setup: (ref) => {
          const subscription = source.open(nodeId, layer.signal).subscribe((node) => {
            ref.setInput('node', node);
          });

          return () => subscription.unsubscribe();
        },
      });
    },
  });

  opened.onClose(() => onClose());
}
