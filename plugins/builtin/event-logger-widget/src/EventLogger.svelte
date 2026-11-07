<script lang="ts">
import {onMount} from 'svelte';
import type {MndwEvent, PluginContext, PluginI18n} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';

// @dprint-ignore
let {events, i18n}: {events: PluginContext['events']; i18n: PluginI18n} = $props();

// svelte-ignore state_referenced_locally
const translator = createTranslator(i18n);

type Row = {
  key: number;
  ts: number;
  event?: MndwEvent;
  marker?: 'resumed' | 'resync';
};

let rows = $state<Row[]>([]);
let paused = $state(false);
let query = $state('');
let nextKey = 0;

const visible = $derived.by(() => {
  const needle = query.trim().toLowerCase();

  return rows.filter((row) => {
    const haystack = row.event
      ? JSON.stringify(row.event)
      : $translator.t(row.marker ?? '');

    return haystack.toLowerCase().includes(needle);
  });
});

function append(row: Omit<Row, 'key'>): void {
  rows = [{...row, key: nextKey++}, ...rows].slice(0, 500);
}

function toggle(): void {
  paused = !paused;

  if (!paused) {
    append({ts: Date.now(), marker: 'resumed'});
  }
}

function download(): void {
  const entries = visible
    .slice()
    .reverse()
    .map((row) => row.event ?? {marker: row.marker, ts: row.ts});

  const logContent = JSON.stringify(entries, null, 2) + '\n';

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
  const eventSubscription = events?.select$('*').subscribe((event) => {
    if (!paused) {
      append({ts: event.ts, event});
    }
  });
  const resyncSubscription = events?.resync$.subscribe(() => {
    if (!paused) {
      append({ts: Date.now(), marker: 'resync'});
    }
  });

  return () => {
    eventSubscription?.unsubscribe();
    resyncSubscription?.unsubscribe();
  };
});
</script>

<section class="logger">
  <span
    hidden
    data-testid="l10n-probe"
  >{$translator.t('l10n.probe')}</span>
  {#if !events}
    <p>{$translator.t('unavailable')}</p>
  {:else}
    <header>
      <mndw-input
        aria-label={$translator.t('filter')}
        placeholder={$translator.t('filter')}
        value={query}
        onmndwinput={(event: CustomEvent<{value: string}>) => {
          query = event.detail.value;
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
      aria-label={$translator.t('l10n.probe')}
    >
      {#each visible as row (row.key)}
        {#if row.event}
          <details>
            <summary>
              <time>{new Date(row.ts).toLocaleTimeString()}</time>
              {row.event.topic} · {row.event.source}
            </summary>
            <pre>{JSON.stringify(row.event, null, 2)}</pre>
          </details>
        {:else}
          <p class="marker">
            <time>{new Date(row.ts).toLocaleTimeString()}</time>
            {$translator.t(row.marker ?? '')}
          </p>
        {/if}
      {:else}
        <p>{$translator.t('empty')}</p>
      {/each}
    </div>
  {/if}
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

pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

time, .marker {
  color: var(--mndw-text-muted);
}
</style>
