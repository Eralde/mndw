import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {ServiceRow} from './service-row.js';
import ServiceActionsCell from './ServiceActionsCell.svelte';

export type ServiceAction = 'start' | 'stop' | 'restart';

export function serviceActionsRenderer(
  onRun: (action: ServiceAction, name: string) => void,
): () => CellRenderer<ServiceRow> {
  return svelteCellWith<
    ServiceRow,
    unknown,
    {onRun: (action: ServiceAction) => void},
    ComponentProps<typeof ServiceActionsCell>
  >(
    ServiceActionsCell,
    (state) => ({
      onRun: (action: ServiceAction) => onRun(action, state.row.service.name),
    }),
  );
}
