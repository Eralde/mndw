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
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      variant="danger"
      disabled={busy || disabled}
      onclick={confirm}
    >
      Yes, reset
    </mndw-button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      variant="secondary"
      disabled={busy || disabled}
      onclick={() => (confirming = false)}
    >
      Cancel
    </mndw-button>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      variant="danger"
      disabled={busy || disabled}
      onclick={start}
    >
      Reset to default{busy ? '...' : ''}
    </mndw-button>
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
