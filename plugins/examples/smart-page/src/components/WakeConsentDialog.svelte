<script lang="ts">
import type {Translator} from '@mndw/sdk';

interface Props {
  i18n: Translator;
  canRemember: boolean;
  onDecision: (confirmed: boolean, remember: boolean) => void;
}

let {i18n, canRemember, onDecision}: Props = $props();
let remember = $state(false);
</script>

<div class="wake-consent">
  {#if canRemember}
    <mndw-checkbox
      checked={remember}
      data-testid="remember-wake-consent"
      onmndwchange={(event: CustomEvent<{checked: boolean}>) => {
        remember = event.detail.checked;
      }}
    >{i18n.t('action.remember-wake-consent')}</mndw-checkbox>
  {/if}
  <div class="actions">
    <mndw-button
      variant="secondary"
      data-testid="cancel-wake"
      data-overlay-initial-focus
      onclick={() => onDecision(false, false)}
    >{i18n.t('action.cancel')}</mndw-button>
    <mndw-button
      variant="primary"
      data-testid="confirm-refresh"
      onclick={() => onDecision(true, canRemember && remember)}
    >{i18n.t('action.confirm-refresh')}</mndw-button>
  </div>
</div>

<style>
.wake-consent {
  display: grid;
  gap: var(--mndw-space-3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
  justify-content: flex-end;
}
</style>
