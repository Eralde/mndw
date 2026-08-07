import {type ApplicationRef, type EnvironmentInjector, createComponent} from '@angular/core';
import type {OverlaySession, PluginContext} from '@mndw/sdk';
import {NodeDrawerComponent} from './components/node-drawer/node-drawer.component';
import type {NodeDetailsSource} from './node-details-source';

export function openNodeDrawer(
  ctx: PluginContext,
  appRef: ApplicationRef,
  injector: EnvironmentInjector,
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
      const ref = createComponent(NodeDrawerComponent, {
        hostElement: target,
        environmentInjector: injector,
      });

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

      appRef.attachView(ref.hostView);

      layer.setCleanup(() => {
        subscription.unsubscribe();
        appRef.detachView(ref.hostView);
        ref.destroy();
      });
    },
  });

  session = opened;
  opened.onClose(() => onClose());
}
