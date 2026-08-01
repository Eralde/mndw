<script lang="ts">
import type {NormalizedLogRecord} from './log-types';
import {highlightText} from './log-highlight';

interface Props {
  record: NormalizedLogRecord;
  query: string;
}

let {record, query}: Props = $props();
const messageSegments = $derived(highlightText(record.text, query));
</script>

<div
  class={`log-row log-row--${record.level.toLocaleLowerCase()}`}
  data-log-id={record.id}
  data-level={record.level}
  role="listitem"
>
  <span class="log-row__level">
    <span aria-hidden="true">{
      record.level === 'Info'
      ? '●'
      : record.level === 'Warning'
      ? '▲'
      : '■'
    }</span>
    <span>{record.label}</span>
  </span>
  <span class="log-row__timestamp">{record.timestamp}</span>
  <span class="log-row__ident">{record.ident}</span>
  <span class="log-row__message">
    {#each messageSegments as segment, index (index)}
      {#if segment.match}
        <mark>{segment.text}</mark>
      {:else}
        {segment.text}
      {/if}
    {/each}
  </span>
</div>

<style>
.log-row {
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr);
  gap: var(--mndw-space-2);
  align-items: baseline;
  padding: var(--mndw-space-1) 0;
  color: var(--mndw-text);
}

.log-row__level {
  display: inline-flex;
  gap: var(--mndw-space-1);
  font-weight: var(--mndw-weight-semibold);
}

.log-row__timestamp,
.log-row__ident {
  color: var(--mndw-text-muted);
}

.log-row--warning .log-row__level {
  color: var(--mndw-warning);
}

.log-row--error .log-row__level,
.log-row--critical .log-row__level {
  color: var(--mndw-danger);
}

.log-row--debug .log-row__level {
  color: var(--mndw-info);
}

mark {
  color: inherit;
  background: var(--mndw-warning-bg);
}

@media (max-width: 700px) {
  .log-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .log-row__timestamp,
  .log-row__ident {
    grid-column: 2;
  }

  .log-row__message {
    grid-column: 1 / -1;
    overflow-wrap: anywhere;
  }
}
</style>
