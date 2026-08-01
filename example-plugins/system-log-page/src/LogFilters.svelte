<script lang="ts">
import {SvelteSet} from 'svelte/reactivity';
import type {LogLevel} from './log-types';
import {ALL_LOG_LEVELS, type FilterState, isFilterActive} from './log-filters';

interface Props {
  state: FilterState;
  onChange: (state: FilterState) => void;
}

let {state: filterState, onChange}: Props = $props();
let expanded = $state(true);

function updateQuery(query: string): void {
  onChange({query, levels: filterState.levels});
}

function updateLevel(level: LogLevel, checked: boolean): void {
  const levels = new SvelteSet(filterState.levels);

  if (checked) {
    levels.add(level);
  } else {
    levels.delete(level);
  }

  onChange({query: filterState.query, levels});
}

function resetFilters(): void {
  onChange({query: '', levels: new SvelteSet(ALL_LOG_LEVELS)});
}
</script>

<section
  class="log-filters"
  aria-label="Log filters"
>
  <div class="log-filters__header">
    <span>Filters</span>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <mndw-button
      variant="ghost"
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse filters' : 'Expand filters'}
      onclick={() => expanded = !expanded}
    >
      {expanded ? 'Hide' : 'Show'}
    </mndw-button>
  </div>

  {#if expanded}
    <div class="log-filters__controls">
      <mndw-input
        type="text"
        aria-label="Search logs"
        placeholder="Search logs"
        value={filterState.query}
        onmndwinput={(event: CustomEvent<{value: string}>) =>
        updateQuery(event.detail.value)}
      ></mndw-input>
      <div
        class="log-filters__levels"
        aria-label="Log levels"
      >
        {#each ALL_LOG_LEVELS as level (level)}
          <mndw-checkbox
            data-level={level}
            checked={filterState.levels.has(level)}
            onmndwchange={(
              event: CustomEvent<
                {checked: boolean; indeterminate: boolean}
              >,
            ) => updateLevel(level, event.detail.checked)}
          >
            {level}
          </mndw-checkbox>
        {/each}
      </div>
    </div>
  {/if}

  {#if isFilterActive(filterState)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <mndw-button
      data-reset-filters
      variant="secondary"
      onclick={resetFilters}
    >
      Reset filters
    </mndw-button>
  {/if}
</section>

<style>
.log-filters {
  display: grid;
  gap: var(--mndw-space-2);
}

.log-filters__header,
.log-filters__controls,
.log-filters__levels {
  display: flex;
  align-items: center;
  gap: var(--mndw-space-3);
  flex-wrap: wrap;
}

.log-filters__header {
  justify-content: space-between;
}
</style>
