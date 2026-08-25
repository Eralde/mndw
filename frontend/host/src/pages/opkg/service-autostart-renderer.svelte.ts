import {mount, unmount} from 'svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ServiceEntry} from '../../services/service-client.js';
import type {ServiceRow} from './service-row.js';
import ServiceAutostartCell from './ServiceAutostartCell.svelte';

export function serviceAutostartRenderer(
  onToggle: (service: ServiceEntry, enabled: boolean) => void,
): () => CellRenderer<ServiceRow> {
  return () => {
    let app: ReturnType<typeof mount> | undefined;
    let props: {row: ServiceRow; onToggle: (enabled: boolean) => void} | undefined;

    return {
      mount(context) {
        const state = $state({
          row: context.row,
          onToggle: (enabled: boolean) => onToggle(state.row.service, enabled),
        });

        props = state;
        app = mount(ServiceAutostartCell, {target: context.node, props: state});
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
