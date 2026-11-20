import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {PackageEntry} from '../../services/opkg-client.js';
import PackageActionsCell from './PackageActionsCell.svelte';

export type PackageRowAction = 'install' | 'upgrade' | 'remove';
export type PackageBusyAction = 'install' | 'remove' | 'upgrade';

export interface PackageCellRow extends PackageEntry {
  busyAction?: PackageBusyAction;
  actionsDisabled?: boolean;
  compact?: boolean;
}

export function packageActionsRenderer(
  onAction: (action: PackageRowAction, name: string) => void,
  onUpdateInSettings: () => void = () => {},
): () => CellRenderer<PackageCellRow> {
  return svelteCellWith<
    PackageCellRow,
    unknown,
    {
      onAction: (action: PackageRowAction) => void;
      onUpdateInSettings: () => void;
    },
    ComponentProps<typeof PackageActionsCell>
  >(
    PackageActionsCell,
    (state) => ({
      onAction: (action) => onAction(action, state.row.name),
      onUpdateInSettings,
    }),
  );
}
