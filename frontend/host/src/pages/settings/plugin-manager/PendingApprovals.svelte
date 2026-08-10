<script lang="ts">
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import CapabilityReview from './CapabilityReview.svelte';

interface Props {
  items: PluginListEntry[];
  busyName: string | null;
  confirmingName: string | null;
  actionError: {name: string; message: string} | null;
  onApprove: (name: string) => void;
  onDeny: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
}

let {
  items,
  busyName,
  confirmingName,
  actionError,
  onApprove,
  onDeny,
  onRequestConfirm,
  onCancelConfirm,
}: Props = $props();
</script>

<section
  class="mndw-pending"
  aria-labelledby="mndw-pending-title"
>
  <h3 id="mndw-pending-title">Pending approvals</h3>

  <ul class="mndw-pending__list">
    {#each items as item (item.name)}
      <li class="mndw-pending__item">
        <div class="mndw-pending__identity">
          <strong>{item.label}</strong>
          <span>{item.name}</span>
        </div>

        <CapabilityReview descriptor={item.backend} />

        {#if actionError?.name === item.name}
          <div
            class="mndw-alert mndw-alert--danger"
            role="alert"
          >
            {actionError.message}
          </div>
        {/if}

        {#if confirmingName === item.name}
          <div class="mndw-pending__confirmation">
            <p>Deny {item.label}? This cannot be undone.</p>
            <div class="mndw-pending__actions">
              <mndw-button
                class="mndw-pending__cancel"
                variant="ghost"
                onclick={onCancelConfirm}
              >
                Cancel
              </mndw-button>
              <mndw-button
                class="mndw-pending__confirm"
                variant="danger"
                disabled={busyName !== null}
                onclick={() => onDeny(item.name)}
              >
                Deny plugin
              </mndw-button>
            </div>
          </div>
        {:else}
          <div class="mndw-pending__actions">
            <mndw-button
              class="mndw-pending__deny"
              variant="danger"
              disabled={busyName !== null}
              onclick={() => onRequestConfirm(item.name)}
            >
              Deny
            </mndw-button>
            <mndw-button
              class="mndw-pending__approve"
              variant="primary"
              disabled={busyName !== null}
              onclick={() => onApprove(item.name)}
            >
              Approve
            </mndw-button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
.mndw-pending {
  display: grid;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.mndw-pending h3 {
  margin: 0;
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-pending__list {
  display: grid;
  gap: var(--mndw-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mndw-pending__item {
  display: grid;
  gap: var(--mndw-space-3);
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  background: var(--mndw-surface-raised);
}

.mndw-pending__identity {
  display: grid;
  gap: var(--mndw-space-1);
}

.mndw-pending__identity strong {
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-pending__identity span {
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-mono);
  font-size: var(--mndw-text-xs);
}

.mndw-pending__confirmation {
  display: grid;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-2);
  border: 1px solid var(--mndw-warning);
  border-radius: var(--mndw-radius-sm);
}

.mndw-pending__confirmation p {
  margin: 0;
  font-size: var(--mndw-text-sm);
}

.mndw-pending__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--mndw-space-2);
}
</style>
