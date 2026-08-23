<script lang="ts">
import {
  PALETTE_CSS_VARIABLES,
  type PaletteContrastWarning,
  type PaletteTokenMap,
} from '@mndw/sdk';

interface Props {
  palette: PaletteTokenMap;
  warnings: PaletteContrastWarning[];
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onDiscard: () => void;
}

let {palette, warnings, busy, error, onConfirm, onDiscard}: Props = $props();

const themes = ['dark', 'light'] as const;
let byTheme = $derived.by(() => {
  return themes.map((theme) => ({
    theme,
    entries: warnings.filter((warning) => warning.theme === theme),
  }));
});
</script>

<div class="mndw-palette-preview">
  <p>
    Previewing the imported palette. Nothing is saved to the device until you
    confirm.
  </p>

  {#each themes as theme (theme)}
    <div>
      <h4>{theme}</h4>
      <ul class="mndw-palette-preview__swatches">
        {#each PALETTE_CSS_VARIABLES as variable (variable.token)}
          <li>
            <span
              class="mndw-palette-preview__chip"
              style="background: {palette[theme][variable.token]}"
            ></span>
            {variable.token}
          </li>
        {/each}
      </ul>
    </div>
  {/each}

  {#each byTheme as group (group.theme)}
    {#if group.entries.length > 0}
      <div class="mndw-palette-preview__warnings">
        <h4>Contrast warnings ({group.theme})</h4>
        <ul>
          {#each group.entries as warning (warning.pair)}
            <li>{warning.pair}: {warning.ratio} (needs {warning.min})</li>
          {/each}
        </ul>
      </div>
    {/if}
  {/each}

  {#if error}
    <div
      class="mndw-alert mndw-alert--danger"
      role="alert"
    >
      {error}
    </div>
  {/if}

  <div class="mndw-palette-preview__actions">
    <mndw-button
      variant="primary"
      disabled={busy}
      onclick={onConfirm}
    >
      Confirm
    </mndw-button>
    <mndw-button
      variant="ghost"
      disabled={busy}
      onclick={onDiscard}
    >
      Discard
    </mndw-button>
  </div>
</div>

<style>
.mndw-palette-preview {
  display: grid;
  gap: var(--mndw-space-3);
}

.mndw-palette-preview__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--mndw-text-xs);
}

.mndw-palette-preview__swatches li {
  display: flex;
  gap: var(--mndw-space-1);
  align-items: center;
}

.mndw-palette-preview__chip {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
}

.mndw-palette-preview__warnings {
  font-size: var(--mndw-text-sm);
  color: var(--mndw-warning, var(--mndw-text));
}

.mndw-palette-preview__actions {
  display: flex;
  gap: var(--mndw-space-2);
}
</style>
