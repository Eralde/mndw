<script lang="ts">
import {SvelteSet} from 'svelte/reactivity';
import type {Readable} from 'svelte/store';
import type {Translator} from '@mndw/sdk';
import {ALL_LOG_LEVELS} from './log-filters';
import type {LogLevel} from './log-types';

interface Props {
  activeLevels: ReadonlySet<LogLevel>;
  translator: Readable<Translator>;
  onChange: (levels: ReadonlySet<LogLevel>) => void;
}

let {activeLevels, translator, onChange}: Props = $props();

function translate(key: string): string {
  return $translator.t(key);
}

function toggle(level: LogLevel): void {
  const nextLevels = new SvelteSet(activeLevels);

  if (nextLevels.has(level)) {
    nextLevels.delete(level);
  } else {
    nextLevels.add(level);
  }

  onChange(nextLevels);
}
</script>

<div
  class="log-level-pills"
  role="group"
  aria-label={translate('filter.levels')}
>
  {#each ALL_LOG_LEVELS as level (level)}
    <mndw-button
      class={`log-level-pills__pill log-level-pills__pill--${level.toLowerCase()}`}
      data-level={level}
      data-active={activeLevels.has(level)}
      aria-pressed={activeLevels.has(level)}
      variant={activeLevels.has(level) ? 'secondary' : 'ghost'}
      onclick={() => toggle(level)}
    >
      {translate(`level.${level.toLowerCase()}`)}
    </mndw-button>
  {/each}
</div>

<style>
.log-level-pills {
  display: flex;
  gap: var(--mndw-space-1);
  flex-wrap: wrap;
  align-items: center;
}

.log-level-pills__pill::part(button) {
  min-height: 28px;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  border-radius: 999px;
  font-size: var(--mndw-text-xs);
  line-height: 1;
}

.log-level-pills__pill[data-active='false']::part(button) {
  border-color: var(--mndw-border);
  background: transparent;
  color: var(--mndw-text-subtle);
}

.log-level-pills__pill[data-active='true']::part(button) {
  font-weight: var(--mndw-weight-semibold);
}

.log-level-pills__pill--info[data-active='true']::part(button),
.log-level-pills__pill--debug[data-active='true']::part(button) {
  border-color: var(--mndw-info);
  background: color-mix(in srgb, var(--mndw-info) 18%, var(--mndw-surface));
  color: var(--mndw-info);
}

.log-level-pills__pill--warning[data-active='true']::part(button) {
  border-color: var(--mndw-warning);
  background: color-mix(in srgb, var(--mndw-warning) 18%, var(--mndw-surface));
  color: var(--mndw-warning);
}

.log-level-pills__pill--error[data-active='true']::part(button),
.log-level-pills__pill--critical[data-active='true']::part(button) {
  border-color: var(--mndw-danger);
  background: color-mix(in srgb, var(--mndw-danger) 18%, var(--mndw-surface));
  color: var(--mndw-danger);
}

.log-level-pills__pill--notice[data-active='true']::part(button) {
  border-color: var(--mndw-text-muted);
  background: color-mix(in srgb, var(--mndw-text-muted) 18%, var(--mndw-surface));
  color: var(--mndw-text-muted);
}
</style>
