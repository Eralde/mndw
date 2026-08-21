import {mount, unmount} from 'svelte';
import type {CellRenderer} from '@mndw/ui';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageActionsCell from './PackageActionsCell.svelte';

export function packageActionsRenderer(
  onRemove: (name: string) => void,
): () => CellRenderer<PackageEntry> {
  return () => {
    let app: ReturnType<typeof mount> | undefined;
    let props: {row: PackageEntry; onRemove: () => void} | undefined;

    return {
      mount(context) {
        const state = $state({
          row: context.row as PackageEntry,
          onRemove: () => onRemove(state.row.name),
        });

        props = state;
        app = mount(PackageActionsCell, {target: context.node, props: state});
      },
      update(context) {
        if (props !== undefined) {
          props.row = context.row as PackageEntry;
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
