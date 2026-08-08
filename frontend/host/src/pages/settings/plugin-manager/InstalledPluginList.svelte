<script lang="ts">
import type {
  PluginBackendDescriptor,
  PluginListEntry,
} from '../../../runtime/plugin-types.js';
import {getPluginVersionWarnings} from '../../../runtime/plugin-version-warnings.svelte.js';
import {getDepsStatus} from '../../../state/deps-status.svelte.js';

interface Props {
  items: PluginListEntry[];
  busyName: string | null;
  confirmingName: string | null;
  actionError: {name: string; message: string} | null;
  permissionVisible: boolean;
  permissionAvailable: boolean;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onPermissionChange: (
    name: string,
    permission: 'persistent-rci-session',
    enabled: boolean,
  ) => void;
  onRestart?: (name: string) => void;
  onDelete: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function backendSummary(backend: PluginBackendDescriptor): string[] {
  const parts: string[] = [];
  const routeEntries = Object.values(backend.routes ?? {});
  const endpointCount =
    routeEntries.filter((route) => route.transport === 'http').length;
  const websocketCount =
    routeEntries.filter((route) => route.transport === 'websocket').length;

  if (endpointCount > 0) {
    parts.push(countLabel(endpointCount, 'endpoint'));
  }

  if (websocketCount > 0) {
    parts.push(countLabel(websocketCount, 'websocket'));
  }

  return parts;
}

function boundedError(value: string): string {
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

const PERSISTENT_RCI_PERMISSION = 'persistent-rci-session' as const;

function permissionGranted(item: PluginListEntry): boolean {
  return item.permissionGrants?.[PERSISTENT_RCI_PERMISSION] ?? false;
}

let {
  items,
  busyName,
  confirmingName,
  actionError,
  permissionVisible = false,
  permissionAvailable = false,
  onEnable,
  onDisable,
  onPermissionChange,
  onRestart = () => {},
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
        {@const versionWarnings = getPluginVersionWarnings(item.name)}
        {@const deps = getDepsStatus(item.name)}
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
            {#if deps === 'installing'}
              <span class="mndw-installed__deps-badge"
              >Installing dependencies…</span>
            {:else if deps === 'failed'}
              <span
                class="mndw-installed__deps-badge mndw-installed__deps-badge--failed"
              >Dependency install failed</span>
            {/if}
            {#if versionWarnings.length > 0}
              <span class="mndw-installed__version-badge"
              >Version mismatch</span>
            {/if}
          </div>

          {#if versionWarnings.length > 0}
            <p class="mndw-installed__version-warning">
              Built against {versionWarnings.join(', ')}. Plugin still loads,
              but may misbehave with this host.
            </p>
          {/if}

          {#if summary.length > 0}
            <p class="mndw-installed__backend">{summary.join(', ')}</p>
          {/if}

          {#if permissionVisible
          && item.permissions?.includes(PERSISTENT_RCI_PERMISSION)}
            <mndw-field
              class="mndw-installed__permission-switch"
              label="Persistent RCI session"
            >
              <mndw-switch
                checked={permissionGranted(item)}
                disabled={busyName !== null
                || (!permissionGranted(item) && !permissionAvailable)}
                onmndwchange={(event: CustomEvent<{checked: boolean}>) =>
                onPermissionChange(
                  item.name,
                  PERSISTENT_RCI_PERMISSION,
                  event.detail.checked,
                )}
              ></mndw-switch>
            </mndw-field>
          {/if}

          {#if actionError?.name === item.name}
            <div
              class="mndw-alert mndw-alert--danger"
              role="alert"
            >
              {actionError.message}
            </div>
          {/if}

          {#if item.source !== 'builtin'}
            <div class="mndw-installed__actions">
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <mndw-button
                class="mndw-installed__toggle"
                variant="primary"
                disabled={busyName !== null}
                onclick={() =>
                item.enabled ? onDisable(item.name) : onEnable(item.name)}
              >
                {item.enabled ? 'Disable' : 'Enable'}
              </mndw-button>
              {#if item.runtime && item.runtime.state !== 'stopped'}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <mndw-button
                  class="mndw-installed__restart"
                  variant="secondary"
                  disabled={busyName !== null}
                  onclick={() => onRestart(item.name)}
                >
                  Restart backend
                </mndw-button>
              {/if}
              {#if confirmingName === item.name}
                <div class="mndw-installed__confirmation">
                  <p>Delete {item.label}? This cannot be undone.</p>
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <mndw-button
                    class="mndw-installed__cancel"
                    variant="ghost"
                    disabled={busyName !== null}
                    onclick={onCancelConfirm}
                  >
                    Cancel
                  </mndw-button>
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <mndw-button
                    class="mndw-installed__confirm"
                    variant="danger"
                    disabled={busyName !== null}
                    onclick={() => onDelete(item.name)}
                  >
                    Delete plugin
                  </mndw-button>
                </div>
              {:else}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <mndw-button
                  class="mndw-installed__delete"
                  variant="danger"
                  disabled={busyName !== null}
                  onclick={() => onRequestConfirm(item.name)}
                >
                  Delete
                </mndw-button>
              {/if}
            </div>
          {/if}

          {#if item.runtime}
            <p class="mndw-installed__runtime">
              Backend: {item.runtime.state}
              {#if item.runtime.requiredProtocol !== undefined}
                <span> · Protocol {item.runtime.requiredProtocol}</span>
              {/if}
              {#if item.runtime.compatible === false}
                <span class="mndw-installed__runtime-warning">
                  · incompatible</span>
              {/if}
              {#if item.runtime.lastError}
                — {boundedError(item.runtime.lastError)}{/if}
            </p>
            {#if item.runtime.compatible === false
          && item.runtime.supportedProtocols}
              <p class="mndw-installed__runtime-warning">
                Supported service protocols: {
                  item.runtime.supportedProtocols.join(', ')
                }
              </p>
            {/if}
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

.mndw-installed__version-badge {
  color: var(--mndw-warning);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-installed__deps-badge {
  color: var(--mndw-warning);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-installed__deps-badge--failed {
  color: var(--mndw-danger);
}

.mndw-installed__version-warning {
  color: var(--mndw-warning);
  font-size: var(--mndw-text-sm);
}

.mndw-installed__runtime {
  color: var(--mndw-text-muted);
  font-family: var(--mndw-font-mono);
  font-size: var(--mndw-text-xs);
}

.mndw-installed__runtime-warning {
  color: var(--mndw-warning);
}

.mndw-installed__confirmation {
  display: grid;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-2);
  border: 1px solid var(--mndw-warning);
  border-radius: var(--mndw-radius-sm);
  font-size: var(--mndw-text-sm);
}
</style>
