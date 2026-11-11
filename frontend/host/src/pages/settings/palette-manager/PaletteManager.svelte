<script lang="ts">
import {onMount} from 'svelte';
import type {PaletteTokenMap} from '@mndw/sdk';
import type {PaletteContrastWarning} from '@mndw/sdk-internal/palette';
import {messageForError} from '../../../services/mgmt-client.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import PaletteExport from './PaletteExport.svelte';
import PaletteImport from './PaletteImport.svelte';
import PalettePreview from './PalettePreview.svelte';
import PaletteReset from './PaletteReset.svelte';
import {getHostServices} from '../../../host-services-context.js';

type State =
  | 'loading'
  | 'idle'
  | 'importing'
  | 'previewing'
  | 'committing'
  | 'resetting'
  | 'importError';

let paletteState = $state<State>('loading');
const paletteService = getHostServices().palette;
let refreshError = $state('');
let importErrors = $state<string[]>([]);
let commitError = $state('');
let resetError = $state('');
let saved = $state(false);
let pending = $state<PaletteTokenMap | null>(null);
let warnings = $state<PaletteContrastWarning[]>([]);

let importDisabled = $derived.by(() => {
  return paletteState === 'loading'
    || paletteState === 'importing'
    || paletteState === 'previewing'
    || paletteState === 'committing'
    || paletteState === 'resetting';
});
let exportDisabled = $derived(paletteState !== 'idle');
let resetDisabled = $derived(paletteState !== 'idle');

/**
 * Localizes palette operation failures. `messageForError` already maps known
 * error kinds (timeouts, mapped MgmtError codes) to catalog keys; anything it
 * passes through verbatim is arbitrary exception text, which must not reach the
 * UI. Those details stay in the console under a localized message that names
 * the failed operation.
 */
function paletteErrorMessage(error: unknown, fallbackKey: string): string {
  const message = messageForError(error);

  if (error instanceof Error && message === error.message) {
    console.error('[mndw] Palette operation failed:', error);

    return hostT(fallbackKey);
  }

  return message;
}

async function load(): Promise<void> {
  if (paletteState !== 'loading' && paletteState !== 'idle') {
    return;
  }

  paletteState = 'loading';

  try {
    await paletteService.refreshPalette();
    refreshError = '';
  } catch (caught) {
    refreshError = paletteErrorMessage(caught, 'settings.palette.load-failed');
  } finally {
    paletteState = 'idle';
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
  paletteState = 'importing';
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
  paletteService.previewOverride(palette);
  paletteState = 'previewing';
}

function onImportErrors(errors: string[]): void {
  importErrors = errors;
  paletteState = 'importError';
}

function dismissImportError(): void {
  importErrors = [];
  paletteState = 'idle';
}

async function confirm(): Promise<void> {
  if (pending === null) {
    return;
  }

  paletteState = 'committing';
  commitError = '';

  try {
    await paletteService.commitOverride(pending);
    pending = null;
    warnings = [];
    saved = true;
    paletteState = 'idle';
  } catch (caught) {
    commitError = paletteErrorMessage(caught, 'settings.palette.operation-failed');
    paletteState = 'previewing';
  }
}

function discard(): void {
  paletteService.discardPreview();
  pending = null;
  warnings = [];
  commitError = '';
  paletteState = 'idle';
}

async function reset(): Promise<void> {
  paletteState = 'resetting';
  resetError = '';

  try {
    await paletteService.resetToDefault();
    saved = false;
  } catch (caught) {
    resetError = paletteErrorMessage(caught, 'settings.palette.operation-failed');
  } finally {
    paletteState = 'idle';
  }
}
</script>

<section class="mndw-palette-manager">
  <h3>{hostT('settings.palette.title')}</h3>

  {#if refreshError}
    <div
      class="mndw-alert mndw-alert--danger"
      role="alert"
    >
      {refreshError}
      <mndw-button
        variant="secondary"
        disabled={paletteState !== 'idle'}
        onclick={() => void load()}
      >
        {hostT('common.retry')}
      </mndw-button>
      <mndw-button
        variant="ghost"
        onclick={dismissRefreshError}
      >
        {hostT('settings.plugin-manager.dismiss')}
      </mndw-button>
    </div>
  {/if}

  {#if paletteState === 'loading'}
    <p role="status">{hostT('settings.palette.loading')}</p>
  {/if}

  {#if paletteState === 'previewing' || paletteState === 'committing'}
    {#if pending}
      <PalettePreview
        busy={paletteState === 'committing'}
        error={commitError}
        onConfirm={() => void confirm()}
        onDiscard={discard}
        palette={pending}
        {warnings}
      />
    {/if}
  {:else}
    {#if paletteState === 'importing'}
      <p role="status">{hostT('settings.palette.reading')}</p>
    {/if}

    <PaletteImport
      disabled={importDisabled}
      onErrors={onImportErrors}
      onImportStart={onImportStart}
      onPreview={onPreview}
    />

    {#if paletteState === 'importError'}
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
          {hostT('settings.plugin-manager.dismiss')}
        </mndw-button>
      </div>
    {/if}

    {#if saved}
      <p role="status">{hostT('settings.palette.saved')}</p>
    {/if}

    <div class="mndw-palette-manager__actions">
      <PaletteExport
        disabled={exportDisabled}
        read={paletteService.getExportable}
      />
      <PaletteReset
        busy={paletteState === 'resetting'}
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
