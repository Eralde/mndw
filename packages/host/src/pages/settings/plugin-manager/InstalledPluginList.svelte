<script lang="ts">
import type {
  PluginBackendDescriptor,
  PluginListEntry,
} from '../../../runtime/plugin-types.js';

interface Props {
  items: PluginListEntry[];
  busyName: string | null;
  confirmingName: string | null;
  actionError: {name: string; message: string} | null;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onDelete: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function backendSummary(backend: PluginBackendDescriptor): string[] {
  const parts: string[] = [];
  const endpointCount = Object.keys(backend.endpoints).length;
  const websocketCount = Object.keys(backend.websockets).length;

  if (endpointCount > 0) {
    parts.push(countLabel(endpointCount, 'endpoint'));
  }

  if (websocketCount > 0) {
    parts.push(countLabel(websocketCount, 'websocket'));
  }

  if (backend.opkg.length > 0) {
    parts.push(countLabel(backend.opkg.length, 'opkg'));
  }

  if (backend.daemon) {
    parts.push('Daemon');
  }

  return parts;
}

let {
  items,
  busyName,
  confirmingName,
  actionError,
  onEnable,
  onDisable,
  onDelete,
  onRequestConfirm,
  onCancelConfirm,
}: Props = $props();
</script>

<section
  class="mndw-installed"
  aria-labelledby="mndw-installed-title"
>
  <h3 id="mndw-installed-title">Installed plugins</h3>

  {#if items.length === 0}
    <p class="mndw-installed__empty">No plugins installed.</p>
  {:else}
    <ul class="mndw-installed__list">
      {#each items as item (item.name)}
        {@const summary = backendSummary(item.backend)}
        <li class="mndw-installed__item">
          <div class="mndw-installed__identity">
            <strong>{item.label}</strong>
            <span>{item.name}</span>
          </div>

          <div class="mndw-installed__metadata">
            <span>Version: {item.version}</span>
            <span>Type: {item.type}</span>
            <span>Source: {item.source}</span>
            {#if item.source === 'builtin'}
              <span class="mndw-installed__builtin">Built-in</span>
            {/if}
          </div>

          {#if summary.length > 0}
            <p class="mndw-installed__backend">{summary.join(', ')}</p>
          {/if}

          {#if item.backend.public}
            <p class="mndw-installed__public">Public backend exposure</p>
          {/if}

          {#if actionError?.name === item.name}
            <p
              class="mndw-installed__error"
              role="alert"
            >
              {actionError.message}
            </p>
          {/if}

          {#if item.source === 'user'}
            <div class="mndw-installed__actions">
              <button
                class="mndw-installed__toggle"
                type="button"
                disabled={busyName !== null}
                onclick={() =>
                item.enabled ? onDisable(item.name) : onEnable(item.name)}
              >
                {item.enabled ? 'Disable' : 'Enable'}
              </button>
              {#if confirmingName === item.name}
                <div class="mndw-installed__confirmation">
                  <p>Delete {item.label}? This cannot be undone.</p>
                  <button
                    class="mndw-installed__cancel"
                    type="button"
                    disabled={busyName !== null}
                    onclick={onCancelConfirm}
                  >
                    Cancel
                  </button>
                  <button
                    class="mndw-installed__confirm"
                    type="button"
                    disabled={busyName !== null}
                    onclick={() => onDelete(item.name)}
                  >
                    Delete plugin
                  </button>
                </div>
              {:else}
                <button
                  class="mndw-installed__delete"
                  type="button"
                  disabled={busyName !== null}
                  onclick={() => onRequestConfirm(item.name)}
                >
                  Delete
                </button>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
.mndw-installed {
  display: grid;
  gap: var(--mndw-space-3);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.mndw-installed h3,
.mndw-installed p {
  margin: 0;
}

.mndw-installed h3 {
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-installed__empty,
.mndw-installed__backend,
.mndw-installed__metadata {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.mndw-installed__list {
  display: grid;
  gap: var(--mndw-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mndw-installed__item {
  display: grid;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  background: var(--mndw-surface-raised);
}

.mndw-installed__identity {
  display: grid;
  gap: var(--mndw-space-1);
}

.mndw-installed__identity strong {
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-installed__identity span {
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-mono);
  font-size: var(--mndw-text-xs);
}

.mndw-installed__metadata,
.mndw-installed__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}

.mndw-installed__builtin {
  color: var(--mndw-accent);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-installed__public,
.mndw-installed__error {
  font-size: var(--mndw-text-sm);
}

.mndw-installed__public {
  color: var(--mndw-warning);
}

.mndw-installed__error {
  color: var(--mndw-danger);
}

.mndw-installed__confirmation {
  display: grid;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-2);
  border: 1px solid var(--mndw-warning);
  border-radius: var(--mndw-radius-sm);
  font-size: var(--mndw-text-sm);
}

.mndw-installed__actions button {
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-2) var(--mndw-space-3);
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
  font: inherit;
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-semibold);
  cursor: pointer;
}

.mndw-installed__actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.mndw-installed__confirm {
  border-color: var(--mndw-danger) !important;
  background: var(--mndw-danger) !important;
  color: var(--mndw-accent-contrast) !important;
}
</style>
