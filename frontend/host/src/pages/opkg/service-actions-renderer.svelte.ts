import {mount, unmount} from 'svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ServiceRow} from './service-row.js';
import ServiceActionsCell from './ServiceActionsCell.svelte';

export type ServiceAction = 'start' | 'stop' | 'restart';

export function serviceActionsRenderer(
  onRun: (action: ServiceAction, name: string) => void,
): () => CellRenderer<ServiceRow> {
  return () => {
    let app: ReturnType<typeof mount> | undefined;
    let props: {row: ServiceRow; onRun: (action: ServiceAction) => void} | undefined;

    return {
      mount(context) {
        const state = $state({
          row: context.row,
          onRun: (action: ServiceAction) => onRun(action, state.row.service.name),
        });

        props = state;
        app = mount(ServiceActionsCell, {target: context.node, props: state});
      },
      update(context) {
        if (props !== undefined) {
          props.row = context.row;
        }
      },
      destroy() {
        if (app !== undefined) {
          unmount(app);
          app = undefined;
        }
        props = undefined;
      },
    };
  };
}
