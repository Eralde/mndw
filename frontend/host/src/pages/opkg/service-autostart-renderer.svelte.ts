import {svelteCellWith} from '@mndw/ui-svelte';
import type {CellRenderer} from '@mndw/ui';
import type {ComponentProps} from 'svelte';
import type {ServiceEntry} from '../../services/service-client.js';
import type {ServiceRow} from './service-row.js';
import ServiceAutostartCell from './ServiceAutostartCell.svelte';

export function serviceAutostartRenderer(
  onToggle: (service: ServiceEntry, enabled: boolean) => void,
): () => CellRenderer<ServiceRow> {
  return svelteCellWith<
    ServiceRow,
    unknown,
    {onToggle: (enabled: boolean) => void},
    ComponentProps<typeof ServiceAutostartCell>
  >(
    ServiceAutostartCell,
    (state) => ({
      onToggle: (enabled: boolean) => onToggle(state.row.service, enabled),
    }),
  );
}
