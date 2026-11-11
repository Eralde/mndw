<script lang="ts">
import type {PaletteTokenMap} from '@mndw/sdk';
import {hostT} from '../../../services/host-i18n.svelte.js';

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

<mndw-button
  variant="secondary"
  {disabled}
  onclick={download}
>
  {hostT('settings.palette.export')}
</mndw-button>
