import {type ApplicationRef, type EnvironmentInjector, createComponent} from '@angular/core';
import type {PluginContext} from '@mndw/sdk';
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
      const subscription = source.open(nodeId, layer.signal).subscribe((node) => {
        ref.setInput('node', node);
      });

      appRef.attachView(ref.hostView);

      layer.setCleanup(() => {
        subscription.unsubscribe();
        appRef.detachView(ref.hostView);
        ref.destroy();
      });
    },
  });

  opened.onClose(() => onClose());
}
