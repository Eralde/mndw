<script lang="ts">
import {onDestroy} from 'svelte';

const {
  close,
  closeImmediately = false,
  onTeardown,
}: {
  close: (result: string) => void;
  closeImmediately?: boolean;
  onTeardown?: () => void;
} = $props();

function closeOnInitialization(): void {
  if (closeImmediately) {
    close('approve');
  }
}

closeOnInitialization();

onDestroy(() => {
  queueMicrotask(() => onTeardown?.());
});
</script>

<button
  class="probe-approve"
  onclick={() => close('approve')}
>
  Approve
</button>
