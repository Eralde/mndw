<script lang="ts">
interface Props {
  message: string;
  confirmLabel: string;
  close: (confirmed: boolean) => void;
}

let {message, confirmLabel, close}: Props = $props();
</script>

<div class="confirm-modal">
  <p>{message}</p>
  <div class="actions">
    <mndw-button
      variant="secondary"
      onclick={() => close(false)}
    >Cancel</mndw-button>
    <mndw-button
      variant="danger"
      onclick={() => close(true)}
    >{confirmLabel}</mndw-button>
  </div>
</div>

<style>
.confirm-modal {
  display: grid;
  gap: 1rem;
  min-width: min(420px, calc(100vw - 32px));
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

p { margin: 0; }
.actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>
