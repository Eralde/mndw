<script lang="ts">
interface Props {
  busy: boolean;
  disabled: boolean;
  error: string;
  onReset: () => void;
}

let {busy, disabled, error, onReset}: Props = $props();
let confirming = $state(false);

function start(): void {
  if (busy || disabled) {
    return;
  }

  confirming = true;
}

function confirm(): void {
  confirming = false;
  onReset();
}
</script>

<div class="mndw-palette-reset">
  {#if confirming}
    <p>Discard the imported palette and return to the built-in colours?</p>
    <button
      disabled={busy || disabled}
      type="button"
      onclick={confirm}
    >
      Yes, reset
    </button>
    <button
      disabled={busy || disabled}
      type="button"
      onclick={() => (confirming = false)}
    >
      Cancel
    </button>
  {:else}
    <button
      disabled={busy || disabled}
      type="button"
      onclick={start}
    >
      Reset to default{busy ? '...' : ''}
    </button>
  {/if}

  {#if error}
    <div
      class="mndw-alert mndw-alert--danger"
      role="alert"
    >
      {error}
    </div>
  {/if}
</div>

<style>
.mndw-palette-reset {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
  align-items: center;
}
</style>
