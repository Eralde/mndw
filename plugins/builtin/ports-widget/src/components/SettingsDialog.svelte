<script lang="ts">
import type {Translator} from '@mndw/sdk/svelte';
import {
  MAX_ROWS,
  ROW_KINDS,
  type RowKind,
  type WidgetSettings,
} from '../model/settings.js';

let {
  settings,
  translator,
  onchange,
}: {
  settings: WidgetSettings;
  translator: Translator;
  onchange: (settings: WidgetSettings) => void;
} = $props();

// svelte-ignore state_referenced_locally
let currentRows = $state<RowKind[]>([...settings.rows]);
let selectedKind = $state<RowKind>('separator');
const availableKinds = $derived(
  ROW_KINDS.filter((kind) =>
    kind === 'separator' || !currentRows.includes(kind)
  ),
);

function commit(rows: RowKind[]): void {
  currentRows = rows;
  onchange({rows});
}

function moveRow(index: number, offset: -1 | 1): void {
  const targetIndex = index + offset;

  if (targetIndex < 0 || targetIndex >= currentRows.length) {
    return;
  }

  const next = [...currentRows];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  commit(next);
}

function removeRow(index: number): void {
  commit(currentRows.filter((_, rowIndex) => rowIndex !== index));
}

function changeKind(event: CustomEvent<{value: string}>): void {
  if (availableKinds.includes(event.detail.value as RowKind)) {
    selectedKind = event.detail.value as RowKind;
  }
}

function addRow(): void {
  if (
    currentRows.length >= MAX_ROWS || !availableKinds.includes(selectedKind)
  ) {
    return;
  }

  const nextRows = [...currentRows, selectedKind];

  commit(nextRows);
  selectedKind =
    ROW_KINDS.find((kind) => kind === 'separator' || !nextRows.includes(kind))
      ?? 'separator';
}
</script>

<div class="settings">
  <fieldset>
    <legend>{translator.t('settings.lines')}</legend>
    <ol class="rows">
      {#each currentRows as kind, index (`${kind}-${index}`)}
        <li>
          <span class="row-name">{translator.t(`row-kind.${kind}`)}</span>
          <div class="actions">
            <mndw-button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={translator.t('settings.moveUp', {
                row: translator.t(`row-kind.${kind}`),
              })}
              disabled={index === 0}
              onclick={() => moveRow(index, -1)}
            ><mndw-icon
                name="arrow-up"
                aria-hidden="true"
              ></mndw-icon></mndw-button>
            <mndw-button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={translator.t('settings.moveDown', {
                row: translator.t(`row-kind.${kind}`),
              })}
              disabled={index === currentRows.length - 1}
              onclick={() => moveRow(index, 1)}
            ><mndw-icon
                name="arrow-down"
                aria-hidden="true"
              ></mndw-icon></mndw-button>
            <mndw-button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={translator.t('settings.removeRow', {
                row: translator.t(`row-kind.${kind}`),
              })}
              onclick={() => removeRow(index)}
            ><mndw-icon
                name="x"
                aria-hidden="true"
              ></mndw-icon></mndw-button>
          </div>
        </li>
      {/each}
    </ol>
    {#if currentRows.length < MAX_ROWS}
      <div class="add-row">
        <mndw-select
          label={translator.t('settings.addRow')}
          value={selectedKind}
          onmndwchange={changeKind}
        >
          {#each availableKinds as kind (kind)}
            <mndw-option value={kind}>{
              translator.t(`row-kind.${kind}`)
            }</mndw-option>
          {/each}
        </mndw-select>
        <mndw-button
          type="button"
          size="sm"
          variant="primary"
          onclick={addRow}
        >
          {translator.t('settings.add')}
        </mndw-button>
      </div>
    {/if}
  </fieldset>
</div>

<style>
.settings {
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
}

fieldset {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
}

legend {
  padding-inline: var(--mndw-space-1);
  font-weight: var(--mndw-weight-semibold);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  min-height: 2rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--mndw-space-2);
}

.row-name {
  min-width: 0;
}

.actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--mndw-space-1);
}

.add-row {
  display: flex;
  align-items: end;
  gap: var(--mndw-space-2);
}

mndw-select {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
