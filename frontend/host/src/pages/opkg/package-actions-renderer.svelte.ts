import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageActionsCell from './PackageActionsCell.svelte';

export type PackageRowAction = 'install' | 'upgrade' | 'remove';

export function packageActionsRenderer(
  onAction: (action: PackageRowAction, name: string) => void,
): () => CellRenderer<PackageEntry> {
  return svelteCellWith<
    PackageEntry,
    unknown,
    {onAction: (action: PackageRowAction) => void},
    ComponentProps<typeof PackageActionsCell>
  >(
    PackageActionsCell,
    (state) => ({
      onAction: (action) => onAction(action, state.row.name),
    }),
  );
}
