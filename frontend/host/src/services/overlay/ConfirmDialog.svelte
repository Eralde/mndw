<script lang="ts">
import {hostT} from '../host-i18n.svelte.js';

interface Props {
  close: (confirmed: boolean) => void;
  confirmLabel?: string;
  cancelLabel?: string;
  danger: boolean;
}

let {close, confirmLabel, cancelLabel, danger}: Props = $props();
</script>

<div class="confirm-dialog">
  <div class="actions">
    <mndw-button
      class="confirm-dialog__cancel"
      variant="secondary"
      data-overlay-initial-focus={danger ? '' : undefined}
      onclick={() => close(false)}
    >{cancelLabel ?? hostT('common.cancel')}</mndw-button>
    <mndw-button
      class="confirm-dialog__confirm"
      variant={danger ? 'danger' : 'primary'}
      data-overlay-initial-focus={!danger ? '' : undefined}
      onclick={() => close(true)}
    >{confirmLabel ?? hostT('common.confirm')}</mndw-button>
  </div>
</div>

<style>
.confirm-dialog {
  min-width: min(420px, calc(100vw - 32px));
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>
