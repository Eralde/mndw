<script lang="ts">
import type {PaletteTokenMap} from '@mndw/sdk';

interface Props {
  disabled: boolean;
  read: () => PaletteTokenMap;
}

let {disabled, read}: Props = $props();

function download(): void {
  const blob = new Blob([JSON.stringify(read(), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = 'mndw-palette.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<mndw-button
  variant="secondary"
  {disabled}
  onclick={download}
>
  Export palette
</mndw-button>
