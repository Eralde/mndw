<script lang="ts">
import {SvelteSet} from 'svelte/reactivity';
import type {Readable} from 'svelte/store';
import type {Translator} from '@mndw/sdk';
import {ALL_LOG_LEVELS, type FilterState, isFilterActive} from './log-filters';
import LogLevelPills from './LogLevelPills.svelte';

interface Props {
  state: FilterState;
  filteredCount: number;
  totalCount: number;
  translator: Readable<Translator>;
  onChange: (state: FilterState) => void;
}

let {state: filterState, filteredCount, totalCount, translator, onChange}:
  Props = $props();
let expanded = $state(false);

function translate(key: string, values?: Record<string, unknown>): string {
  return $translator.t(key, values);
}

function updateQuery(query: string): void {
  onChange({query, levels: filterState.levels});
}

function resetFilters(): void {
  onChange({query: '', levels: new SvelteSet(ALL_LOG_LEVELS)});
}
</script>

<section
  class="log-filters"
  data-filter-panel
  data-expanded={expanded}
  aria-label={translate('filter.aria-label')}
>
  <div class="log-filters__header">
    <div class="log-filters__summary">
      <mndw-button
        data-filter-toggle
        variant="ghost"
        aria-expanded={expanded}
        aria-label={translate(expanded ? 'filter.hide' : 'filter.show')}
        onclick={() => expanded = !expanded}
      >
        <span class:log-filters__toggle--active={isFilterActive(filterState)}>
          {translate('filter.label')} {expanded ? '▲' : '▼'}
        </span>
      </mndw-button>
      <span class="log-filters__count">
        <span
          class="log-filters__count-full"
          data-filtered-count={filteredCount}
          data-loaded-count={totalCount}
        >
          {
            translate('filter.showing', {filtered: filteredCount,
            total: totalCount})
          }
        </span>
        <span class="log-filters__count-compact">
          {
            translate('filter.showing-compact', {
              filtered: filteredCount,
              total: totalCount,
            })
          }
        </span>
      </span>
      {#if isFilterActive(filterState)}
        <mndw-button
          data-reset-filters
          variant="secondary"
          onclick={resetFilters}
        >
          {translate('filter.reset')}
        </mndw-button>
      {/if}
    </div>
  </div>

  <div
    class="log-filters__controls"
    class:collapsed={!expanded}
  >
    <mndw-input
      type="text"
      aria-label={translate('filter.search')}
      placeholder={translate('filter.placeholder')}
      value={filterState.query}
      onmndwinput={(event: CustomEvent<{value: string}>) =>
      updateQuery(event.detail.value)}
    ></mndw-input>
    <LogLevelPills
      activeLevels={filterState.levels}
      {translator}
      onChange={(levels) => onChange({query: filterState.query, levels})}
    />
  </div>
</section>

<style>
.log-filters {
  min-width: 0;
  container-type: inline-size;
  container-name: log-filters;
}

.log-filters__header,
.log-filters__summary,
.log-filters__controls {
  display: flex;
  align-items: center;
  gap: var(--mndw-space-2);
  flex-wrap: wrap;
}

.log-filters__header {
  min-height: 32px;
}

.log-filters__summary {
  min-width: 0;
}

.log-filters__count {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
  white-space: nowrap;
}

.log-filters__count-compact {
  display: none;
}

.log-filters__toggle--active {
  color: var(--mndw-accent);
}

.log-filters__controls {
  --log-filter-focus-gutter: calc(var(--mndw-focus-w) + 1px);

  max-height: 300px;
  padding: 0 var(--log-filter-focus-gutter) var(--log-filter-focus-gutter);
  opacity: 1;
  overflow: hidden;
  transition: max-height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out;
}

.log-filters__controls:not(.collapsed) {
  padding-top: calc(var(--mndw-space-2) + var(--log-filter-focus-gutter));
}

.log-filters__controls.collapsed {
  max-height: 0;
  padding: 0;
  opacity: 0;
  pointer-events: none;
}

mndw-input {
  flex: 0 1 190px;
  min-width: 120px;
}

@container log-filters (max-width: 420px) {
  .log-filters__count-full {
    display: none;
  }

  .log-filters__count-compact {
    display: inline;
  }
}
</style>
