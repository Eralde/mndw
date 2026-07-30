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

let phase = $state<State>('loading');
let refreshError = $state('');
let importErrors = $state<string[]>([]);
let commitError = $state('');
let resetError = $state('');
let saved = $state(false);
let pending = $state<PaletteTokenMap | null>(null);
let warnings = $state<PaletteContrastWarning[]>([]);

let importDisabled = $derived(
  phase === 'loading'
    || phase === 'importing'
    || phase === 'previewing'
    || phase === 'committing'
    || phase === 'resetting',
);
let exportDisabled = $derived(phase !== 'idle');
let resetDisabled = $derived(phase !== 'idle');

async function load(): Promise<void> {
  if (phase !== 'loading' && phase !== 'idle') {
    return;
  }

  phase = 'loading';

  try {
    await refreshPalette();
    refreshError = '';
  } catch (caught) {
    refreshError = messageForError(caught);
  } finally {
    phase = 'idle';
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
  phase = 'importing';
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
  phase = 'previewing';
}

function onImportErrors(errors: string[]): void {
  importErrors = errors;
  phase = 'importError';
}

function dismissImportError(): void {
  importErrors = [];
  phase = 'idle';
}

async function confirm(): Promise<void> {
  if (pending === null) {
    return;
  }

  phase = 'committing';
  commitError = '';

  try {
    await commitOverride(pending);
    pending = null;
    warnings = [];
    saved = true;
    phase = 'idle';
  } catch (caught) {
    commitError = messageForError(caught);
    phase = 'previewing';
  }
}

function discard(): void {
  discardPreview();
  pending = null;
  warnings = [];
  commitError = '';
  phase = 'idle';
}

async function reset(): Promise<void> {
  phase = 'resetting';
  resetError = '';

  try {
    await resetToDefault();
    saved = false;
  } catch (caught) {
    resetError = messageForError(caught);
  } finally {
    phase = 'idle';
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
      <button
        disabled={phase !== 'idle'}
        type="button"
        onclick={() => void load()}
      >
        Retry
      </button>
      <button
        type="button"
        onclick={dismissRefreshError}
      >
        Dismiss
      </button>
    </div>
  {/if}

  {#if phase === 'loading'}
    <p role="status">Loading palette...</p>
  {/if}

  {#if phase === 'previewing' || phase === 'committing'}
    {#if pending}
      <PalettePreview
        busy={phase === 'committing'}
        error={commitError}
        onConfirm={() => void confirm()}
        onDiscard={discard}
        palette={pending}
        {warnings}
      />
    {/if}
  {:else}
    {#if phase === 'importing'}
      <p role="status">Reading palette...</p>
    {/if}

    <PaletteImport
      disabled={importDisabled}
      onErrors={onImportErrors}
      onImportStart={onImportStart}
      onPreview={onPreview}
    />

    {#if phase === 'importError'}
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        <ul>
          {#each importErrors as problem (problem)}
            <li>{problem}</li>
          {/each}
        </ul>
        <button
          type="button"
          onclick={dismissImportError}
        >
          Dismiss
        </button>
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
        busy={phase === 'resetting'}
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
