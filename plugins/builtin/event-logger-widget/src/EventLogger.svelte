<script lang="ts">
import {onMount, tick} from 'svelte';
import type {PluginContext, PluginI18n, PluginStorage} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {
  EVENT_CATEGORIES,
  type EventCategory,
  isEventCategory,
  matchesCategory,
} from './categories.js';
import {summarizeEvent} from './event-summary.js';
import {type EventRow, groupRows} from './rows.js';
import {isAtBottom} from './scroll.js';

// @dprint-ignore
let {events, i18n, storage}: {events: PluginContext['events']; i18n: PluginI18n; storage: PluginStorage} = $props();

// svelte-ignore state_referenced_locally
const translator = createTranslator(i18n);

const CATEGORY_STORAGE_KEY = 'category';

let rows = $state<EventRow[]>([]);
let paused = $state(false);
let query = $state('');
let category = $state<EventCategory>('all');
let entries = $state<HTMLElement | null>(null);
let categoryTouched = false;
let nextKey = 0;

const visible = $derived.by(() => {
  const needle = query.trim().toLowerCase();

  return rows.filter((row) => {
    if (
      row.event !== undefined && !matchesCategory(row.event.topic, category)
    ) {
      return false;
    }

    const haystack = row.event !== undefined
      ? `${summarizeEvent(row.event, $translator)}\n${
        JSON.stringify(row.event)
      }`
      : $translator.t(row.marker ?? '');

    return haystack.toLowerCase().includes(needle);
  });
});

const groups = $derived.by(() => {
  return groupRows(visible);
});

function append(row: Omit<EventRow, 'key'>): void {
  const stick = entries !== null && isAtBottom(entries);

  rows = [...rows, {...row, key: nextKey++}].slice(-500);

  if (stick) {
    scrollToBottomAfterUpdate();
  }
}

function scrollToBottom(): void {
  if (entries !== null) {
    entries.scrollTop = entries.scrollHeight;
  }
}

function scrollToBottomAfterUpdate(): void {
  void tick().then(() => {
    scrollToBottom();
  });
}

function selectCategory(value: string): void {
  if (!isEventCategory(value)) {
    return;
  }

  categoryTouched = true;
  category = value;
  scrollToBottomAfterUpdate();

  void storage.set(CATEGORY_STORAGE_KEY, value).catch(() => undefined);
}

function toggle(): void {
  paused = !paused;

  if (!paused) {
    append({ts: Date.now(), marker: 'resumed'});
  }
}

function download(): void {
  const exportedRows = visible.map((row) =>
    row.event ?? {marker: row.marker, ts: row.ts}
  );

  const logContent = JSON.stringify(exportedRows, null, 2) + '\n';

  const blob = new Blob([logContent], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  const timestampStr = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

  anchor.href = url;
  anchor.download = `mndw-events-${timestampStr}.json`;

  anchor.click();
  URL.revokeObjectURL(url);
}

onMount(() => {
  let active = true;

  void storage.get(CATEGORY_STORAGE_KEY)
    .then((value) => {
      if (active && !categoryTouched && isEventCategory(value)) {
        category = value;
        scrollToBottomAfterUpdate();
      }
    })
    .catch(() => undefined);

  const eventSubscription = events.select$('*').subscribe((event) => {
    if (!paused) {
      append({ts: event.ts, event});
    }
  });
  const resyncSubscription = events.resync$.subscribe(() => {
    if (!paused) {
      append({ts: Date.now(), marker: 'resync'});
    }
  });

  scrollToBottomAfterUpdate();

  return () => {
    active = false;
    eventSubscription.unsubscribe();
    resyncSubscription.unsubscribe();
  };
});
</script>

<section class="logger">
  <header>
    <mndw-select
      class="category"
      label={$translator.t('category')}
      value={category}
      onmndwchange={(event: CustomEvent<{value: string}>) => {
        selectCategory(event.detail.value);
      }}
    >
      {#each EVENT_CATEGORIES as item (item)}
        <mndw-option value={item}>{
          $translator.t(`category.${item}`)
        }</mndw-option>
      {/each}
    </mndw-select>
    <mndw-input
      aria-label={$translator.t('filter')}
      placeholder={$translator.t('filter')}
      value={query}
      onmndwinput={(event: CustomEvent<{value: string}>) => {
        query = event.detail.value;
        scrollToBottomAfterUpdate();
      }}
    >
    </mndw-input>
    <div class="actions">
      <mndw-button onclick={toggle}>
        {$translator.t(paused ? 'resume' : 'pause')}
      </mndw-button>
      <mndw-button
        onclick={() => {
          rows = [];
          scrollToBottomAfterUpdate();
        }}
      >{$translator.t('clear')}</mndw-button>
      <mndw-button onclick={download}>
        {$translator.t('download')}
      </mndw-button>
    </div>
  </header>
  <div
    class="entries"
    role="region"
    aria-label={$translator.t('entries')}
    bind:this={entries}
  >
    {#each groups as group (group.key)}
      {#if group.row.event}
        {@const event = group.row.event}
        <details>
          <summary>
            <time>{
              $translator.formatDate(new Date(group.row.ts), {
                timeStyle: 'medium',
              })
            }</time>
            <span class="summary">{summarizeEvent(event, $translator)}</span>
            {#if group.count > 1}
              <span
                class="count"
                aria-hidden="true"
              >×{group.count}</span>
              <span class="sr-only">{
                $translator.t('repeated', {count: group.count})
              }</span>
            {/if}
          </summary>
          <p class="meta">{event.topic} · {event.source}</p>
          <pre>{JSON.stringify(event, null, 2)}</pre>
        </details>
      {:else}
        <p class="marker">
          <time>{
            $translator.formatDate(new Date(group.row.ts), {
              timeStyle: 'medium',
            })
          }</time>
          {$translator.t(group.row.marker ?? '')}
        </p>
      {/if}
    {:else}
      <p>{$translator.t('empty')}</p>
    {/each}
  </div>
</section>

<style>
.logger {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-2);
  height: 100%;
  min-height: 0;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

header {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

.category {
  flex: 0 1 9.5rem;
  min-width: 0;
}

mndw-input {
  flex: 1 1 12rem;
  min-width: 0;
}

.entries {
  flex: 1;
  overflow: auto;
  min-height: 0;
  font-size: var(--mndw-text-sm);
  font-family: var(--mndw-font-mono);
}

details, .marker {
  padding: var(--mndw-space-2);
  border-bottom: 1px solid var(--mndw-border);
}

summary {
  overflow-wrap: anywhere;
  cursor: pointer;
}

.count {
  margin-left: var(--mndw-space-1);
  color: var(--mndw-text-muted);
}

.meta {
  margin: 0 0 var(--mndw-space-2);
  color: var(--mndw-text-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

time, .marker {
  color: var(--mndw-text-muted);
}
</style>
