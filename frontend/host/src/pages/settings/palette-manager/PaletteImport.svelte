<script lang="ts">
import type {PaletteTokenMap} from '@mndw/sdk';
import {
  type PaletteContrastWarning,
  validateImportedPalette,
} from '@mndw/sdk-internal/palette';
import {hostT} from '../../../services/host-i18n.svelte.js';

interface Props {
  disabled: boolean;
  onImportStart: () => void;
  onPreview: (
    palette: PaletteTokenMap,
    warnings: PaletteContrastWarning[],
  ) => void;
  onErrors: (errors: string[]) => void;
}

let {disabled, onImportStart, onPreview, onErrors}: Props = $props();

async function read(file: File): Promise<void> {
  let text: string;

  try {
    text = await file.text();
  } catch (error) {
    console.error('[mndw] Could not read palette file:', error);
    onErrors([hostT('settings.palette.read-failed')]);

    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error('[mndw] Could not parse palette JSON:', error);
    onErrors([hostT('settings.palette.invalid-json')]);

    return;
  }

  const validation = validateImportedPalette(parsed);

  if (validation.palette === null) {
    // Structural errors carry arbitrary SDK wording; keep details in the
    // console and show a localized generic message.
    console.error('[mndw] Imported palette is invalid:', validation.structuralErrors);
    onErrors([hostT('settings.palette.invalid-structure')]);

    return;
  }

  onPreview(validation.palette, validation.contrastWarnings);
}

function begin(file: File): void {
  if (disabled) {
    return;
  }

  onImportStart();
  void read(file);
}

function onInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];

  if (file) {
    begin(file);
  }

  input.value = '';
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];

  if (file) {
    begin(file);
  }
}
</script>

<label
  class="mndw-palette-import"
  ondragover={(event) => event.preventDefault()}
  ondrop={onDrop}
>
  <input
    accept=".json,application/json"
    aria-label={hostT('settings.palette-import-aria-label')}
    {disabled}
    type="file"
    onchange={onInput}
  />
  <span>{hostT('settings.palette.drop')}</span>
</label>

<style>
.mndw-palette-import {
  display: grid;
  gap: var(--mndw-space-2);
  border: 1px dashed var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-4);
  cursor: pointer;
}

.mndw-palette-import input {
  min-height: var(--mndw-control-h);
  box-sizing: border-box;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  max-width: 100%;
}
</style>
