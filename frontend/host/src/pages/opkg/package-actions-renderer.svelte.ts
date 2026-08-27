import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageActionsCell from './PackageActionsCell.svelte';

export function packageActionsRenderer(
  onRemove: (name: string) => void,
): () => CellRenderer<PackageEntry> {
  return svelteCellWith<
    PackageEntry,
    unknown,
    {onRemove: () => void},
    ComponentProps<typeof PackageActionsCell>
  >(
    PackageActionsCell,
    (state) => ({
      onRemove: () => onRemove(state.row.name),
    }),
  );
}
