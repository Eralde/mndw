<script lang="ts">
import type {Translator} from '@mndw/sdk';
import type {HistoryEntry} from '../model/history.js';
import {formatBitRate} from '../model/format.js';

interface Props {
  history: readonly HistoryEntry[];
  translator: Translator;
  onClose: () => void;
}

let {history, translator, onClose}: Props = $props();
</script>

{#if history.length === 0}
  <p>{translator.t('history.empty')}</p>
{:else}
  <div class="history">
    <div
      class="entries"
      role="list"
    >
      {#each history as entry (entry.at)}
        {@const download = formatBitRate(entry.downloadBps, translator.locale)}
        {@const upload = formatBitRate(entry.uploadBps, translator.locale)}
        {@const ping = entry.pingMs === null
        ? '—'
        : `${
          translator.formatNumber(entry.pingMs, {
            maximumFractionDigits: 1,
          })
        } ms`}
        <article
          class="entry"
          role="listitem"
        >
          <div class="entry-meta">
            <time datetime={new Date(entry.at).toISOString()}>
              {
                translator.formatDate(new Date(entry.at), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })
              }
            </time>
            <span
              class="server"
              title={entry.server}
            >{entry.server}</span>
          </div>
          <div class="entry-values">
            <span
              role="group"
              aria-label={`${translator.t('result.download')}: ${download}`}
            ><span aria-hidden="true">↓</span> <span class="download-value">{
                download
              }</span></span>
            <span
              role="group"
              aria-label={`${translator.t('result.upload')}: ${upload}`}
            ><span aria-hidden="true">↑</span> <span class="upload-value">{
                upload
              }</span></span>
            <span
              role="group"
              aria-label={`${translator.t('result.ping')}: ${ping}`}
            ><span aria-hidden="true">{translator.t('result.ping')}</span> {
                ping
              }</span>
          </div>
        </article>
      {/each}
    </div>
  </div>
{/if}
<mndw-button
  type="button"
  variant="ghost"
  onclick={onClose}
>{translator.t('action.close')}</mndw-button>

<style>
.history {
  display: grid;
  gap: 0.5rem;
  max-block-size: 60vh;
  overflow: auto;
}

.entry-values {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.entries {
  display: grid;
  gap: 0.5rem;
}

.entry {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.35rem 0.5rem;
  border-block-end: var(--mndw-border-w) solid var(--mndw-border);
  padding-block-end: 0.5rem;
}

.entry-meta {
  grid-column: 1 / -1;
  display: flex;
  min-inline-size: 0;
  align-items: baseline;
  gap: 0.5rem;
  overflow: hidden;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
  white-space: nowrap;
}

.server {
  min-inline-size: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entry-values {
  grid-column: 1 / -1;
  min-inline-size: 0;
  font-size: var(--mndw-text-sm);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.download-value {
  color: var(--mndw-accent);
}

.upload-value {
  color: var(--mndw-success);
}
</style>
