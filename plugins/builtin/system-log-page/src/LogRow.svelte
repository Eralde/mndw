<script lang="ts">
import type {NormalizedLogRecord} from './log-types';
import {highlightText} from './log-highlight';

interface Props {
  record: NormalizedLogRecord;
  query: string;
}

let {record, query}: Props = $props();
const messageSegments = $derived(highlightText(record.text, query));
const levelMarker = $derived.by(() => {
  return record.level === 'Info'
    ? '●'
    : record.level === 'Warning'
    ? '▲'
    : record.level === 'Notice'
    ? '·'
    : '■';
});
</script>

<div
  class={`log-row log-row--${record.level.toLowerCase()}`}
  data-log-id={record.id}
  data-level={record.level}
  role="listitem"
>
  <span class="log-row__level">
    <span
      data-level-marker
      aria-hidden="true"
    >{levelMarker}</span>
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
  display: flex;
  flex-direction: row;
  gap: var(--mndw-space-2);
  align-items: baseline;
  padding: var(--mndw-space-1) 0;
  font-family: var(--mndw-font-mono);
  font-size: var(--mndw-text-xs);
  line-height: 1.4;
  color: var(--mndw-text);
}

.log-row__level {
  display: inline-flex;
  flex: 0 0 auto;
  gap: var(--mndw-space-1);
  font-weight: var(--mndw-weight-semibold);
}

.log-row__timestamp,
.log-row__ident {
  flex: 0 0 auto;
  color: var(--mndw-text-muted);
}

.log-row__timestamp {
  width: 20ch;
}

.log-row__ident {
  width: 16ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-row__message {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.log-row--info .log-row__level {
  color: var(--mndw-info);
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

.log-row--notice .log-row__level {
  color: var(--mndw-text-muted);
}

mark {
  color: var(--mndw-text);
  background: color-mix(in srgb, var(--mndw-warning) 28%, var(--mndw-surface-raised));
  font-weight: var(--mndw-weight-semibold);
}

@media (max-width: 700px) {
  .log-row {
    flex-wrap: wrap;
    column-gap: var(--mndw-space-2);
    row-gap: var(--mndw-space-1);
  }

  .log-row__message {
    flex-basis: 100%;
  }
}
</style>
