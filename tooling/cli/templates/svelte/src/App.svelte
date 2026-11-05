<script lang="ts">
import type {PluginContext} from '@mndw/sdk';
import {type MndwTableProps, column} from '@mndw/ui';
import {createTranslator} from '@mndw/sdk/svelte';
import {svelteCell} from '@mndw/ui-svelte';
import TableNameCell from './TableNameCell.svelte';

interface TableRow {
  id: string;
  name: string;
}

let {ctx}: {ctx: PluginContext} = $props();
const translator = $derived(createTranslator(ctx.i18n));
const theme$ = $derived(ctx.theme$);
const rows = $derived<TableRow[]>([
  {id: 'first', name: $translator.t('table.first')},
  {id: 'second', name: $translator.t('table.second')},
]);
const columns = $derived([
  column<TableRow>()({
    id: 'name',
    label: $translator.t('table.column'),
    accessor: (row) => row.name,
    renderer: svelteCell<TableRow, string>()(TableNameCell),
  }),
]);
let table: (HTMLElement & MndwTableProps<TableRow>) | undefined = $state();

$effect(() => {
  if (table === undefined) {
    return;
  }

  Object.assign(table, {
    columns,
    rows,
    rowKey: 'id',
    caption: $translator.t('table.caption'),
    columnMenu: false,
  });
});

let count = $state(0);
</script>

<div
  class="wrap"
  data-theme={$theme$}
>
  <h3
    class="title"
    data-testid="l10n-probe"
    data-plugin-label="__MNDW_LABEL__"
  >
    {$translator.t('l10n.probe')}
  </h3>
  <p class="device">Device: {ctx.deviceInfo.deviceName}</p>
  <button
    class="count"
    type="button"
    onclick={() => count++}
  >
    {$translator.t('l10n.button')} {count}
  </button>
  <p class="result">{$translator.t('l10n.result')}</p>
  <mndw-table bind:this={table}></mndw-table>
</div>

<style>
.wrap {
  padding: var(--mndw-space-4);
  font-family: var(--mndw-font-sans);
  color: var(--mndw-text);
  background: var(--mndw-surface);
}

.title {
  margin: 0 0 var(--mndw-space-2);
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.device {
  margin: 0 0 var(--mndw-space-3);
  color: var(--mndw-text-muted);
}

.count {
  padding: var(--mndw-space-2) var(--mndw-space-3);
  font: inherit;
  color: var(--mndw-accent-contrast);
  background: var(--mndw-accent);
  border: none;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
}

.count:hover {
  background: var(--mndw-accent-hover);
}
</style>
