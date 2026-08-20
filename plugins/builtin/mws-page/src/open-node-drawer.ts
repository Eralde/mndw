import type {ApplicationRef} from '@angular/core';
import type {OverlaySession, PluginContext} from '@mndw/sdk';
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
  let session: OverlaySession | null = null;
  let lastAppliedTitle = title;

  const opened = ctx.overlay.open({
    kind: 'drawer',
    title,
    width: 400,
    closeOnOutsideClick: true,
    mount(target, layer) {
      mountComponentInOverlay({
        appRef,
        target,
        layer,
        component: NodeDrawerComponent,
        setup: (ref) => {
          ref.setInput('setTitle', (nextTitle: string) => {
            if (nextTitle === lastAppliedTitle) {
              return;
            }

            lastAppliedTitle = nextTitle;
            session?.update({title: nextTitle});
          });

          const subscription = source.open(nodeId, layer.signal).subscribe((node) => {
            ref.setInput('node', node);

            if (node !== null && node.name !== lastAppliedTitle) {
              lastAppliedTitle = node.name;
              session?.update({title: node.name});
            }
          });

          return () => subscription.unsubscribe();
        },
      });
    },
  });

  session = opened;
  opened.onClose(() => onClose());
}
