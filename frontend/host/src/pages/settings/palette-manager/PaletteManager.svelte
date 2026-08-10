<script lang="ts">
import {onMount} from 'svelte';
import type {PaletteContrastWarning, PaletteTokenMap} from '@mndw/sdk';
import {messageForError} from '../../../services/mgmt-client.js';
import {
  commitOverride,
  discardPreview,
  getExportable,
  previewOverride,
  refreshPalette,
  resetToDefault,
} from '../../../services/palette.service.js';
import PaletteExport from './PaletteExport.svelte';
import PaletteImport from './PaletteImport.svelte';
import PalettePreview from './PalettePreview.svelte';
import PaletteReset from './PaletteReset.svelte';

type State =
  | 'loading'
  | 'idle'
  | 'importing'
  | 'previewing'
  | 'committing'
  | 'resetting'
  | 'importError';

let state = $state<State>('loading');
let refreshError = $state('');
let importErrors = $state<string[]>([]);
let commitError = $state('');
let resetError = $state('');
let saved = $state(false);
let pending = $state<PaletteTokenMap | null>(null);
let warnings = $state<PaletteContrastWarning[]>([]);

let importDisabled = $derived.by(() => {
  return state === 'loading'
    || state === 'importing'
    || state === 'previewing'
    || state === 'committing'
    || state === 'resetting';
});
let exportDisabled = $derived(state !== 'idle');
let resetDisabled = $derived(state !== 'idle');

async function load(): Promise<void> {
  if (state !== 'loading' && state !== 'idle') {
    return;
  }

  state = 'loading';

  try {
    await refreshPalette();
    refreshError = '';
  } catch (caught) {
    refreshError = messageForError(caught);
  } finally {
    state = 'idle';
  }
}

function dismissRefreshError(): void {
  refreshError = '';
}

onMount(() => {
  void load();
});

function onImportStart(): void {
  importErrors = [];
  commitError = '';
  saved = false;
  state = 'importing';
}

function onPreview(
  palette: PaletteTokenMap,
  next: PaletteContrastWarning[],
): void {
  importErrors = [];
  commitError = '';
  saved = false;
  pending = palette;
  warnings = next;
  previewOverride(palette);
  state = 'previewing';
}

function onImportErrors(errors: string[]): void {
  importErrors = errors;
  state = 'importError';
}

function dismissImportError(): void {
  importErrors = [];
  state = 'idle';
}

async function confirm(): Promise<void> {
  if (pending === null) {
    return;
  }

  state = 'committing';
  commitError = '';

  try {
    await commitOverride(pending);
    pending = null;
    warnings = [];
    saved = true;
    state = 'idle';
  } catch (caught) {
    commitError = messageForError(caught);
    state = 'previewing';
  }
}

function discard(): void {
  discardPreview();
  pending = null;
  warnings = [];
  commitError = '';
  state = 'idle';
}

async function reset(): Promise<void> {
  state = 'resetting';
  resetError = '';

  try {
    await resetToDefault();
    saved = false;
  } catch (caught) {
    resetError = messageForError(caught);
  } finally {
    state = 'idle';
  }
}
</script>

<section class="mndw-palette-manager">
  <h3>Palette</h3>

  {#if refreshError}
    <div
      class="mndw-alert mndw-alert--danger"
      role="alert"
    >
      {refreshError}
      <mndw-button
        variant="secondary"
        disabled={state !== 'idle'}
        onclick={() => void load()}
      >
        Retry
      </mndw-button>
      <mndw-button
        variant="ghost"
        onclick={dismissRefreshError}
      >
        Dismiss
      </mndw-button>
    </div>
  {/if}

  {#if state === 'loading'}
    <p role="status">Loading palette...</p>
  {/if}

  {#if state === 'previewing' || state === 'committing'}
    {#if pending}
      <PalettePreview
        busy={state === 'committing'}
        error={commitError}
        onConfirm={() => void confirm()}
        onDiscard={discard}
        palette={pending}
        {warnings}
      />
    {/if}
  {:else}
    {#if state === 'importing'}
      <p role="status">Reading palette...</p>
    {/if}

    <PaletteImport
      disabled={importDisabled}
      onErrors={onImportErrors}
      onImportStart={onImportStart}
      onPreview={onPreview}
    />

    {#if state === 'importError'}
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        <ul>
          {#each importErrors as problem (problem)}
            <li>{problem}</li>
          {/each}
        </ul>
        <mndw-button
          variant="ghost"
          onclick={dismissImportError}
        >
          Dismiss
        </mndw-button>
      </div>
    {/if}

    {#if saved}
      <p role="status">Saved.</p>
    {/if}

    <div class="mndw-palette-manager__actions">
      <PaletteExport
        disabled={exportDisabled}
        read={getExportable}
      />
      <PaletteReset
        busy={state === 'resetting'}
        disabled={resetDisabled}
        error={resetError}
        onReset={() => void reset()}
      />
    </div>
  {/if}
</section>

<style>
.mndw-palette-manager {
  display: grid;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.mndw-palette-manager__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-3);
  align-items: center;
}
</style>
