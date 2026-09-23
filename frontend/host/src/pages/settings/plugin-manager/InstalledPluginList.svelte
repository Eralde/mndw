<script lang="ts">
import {PERSISTENT_RCI_PERMISSIONS, type PluginPermission} from '@mndw/sdk';
import type {
  PluginBackendDescriptor,
  PluginListEntry,
} from '../../../runtime/plugin-types.js';
import {getPluginVersionWarnings} from '../../../runtime/plugin-version-warnings.svelte.js';
import {getDepsStatus} from '../../../state/deps-status.svelte.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import type {PluginRowState} from './reconcile.js';

interface Props {
  items: PluginListEntry[];
  confirmingName: string | null;
  rowStateFor: (name: string) => PluginRowState | undefined;
  permissionVisible: boolean;
  permissionAvailable: boolean;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onPermissionChange: (
    name: string,
    permission: PluginPermission,
    enabled: boolean,
  ) => void;
  onRestart?: (name: string) => void;
  onDelete: (name: string) => void;
  onRequestConfirm: (name: string) => void;
  onCancelConfirm: () => void;
  onRefresh: () => void;
}

function countLabel(
  count: number,
  singularKey: string,
  pluralKey: string,
): string {
  return hostT(count === 1 ? singularKey : pluralKey, {count});
}

function backendSummary(backend: PluginBackendDescriptor): string[] {
  const parts: string[] = [];
  const routeEntries = Object.values(backend.routes ?? {});
  const endpointCount =
    routeEntries.filter((route) => route.transport === 'http').length;
  const websocketCount =
    routeEntries.filter((route) => route.transport === 'websocket').length;

  if (endpointCount > 0) {
    parts.push(countLabel(
      endpointCount,
      'settings.plugin-manager.endpoint-one',
      'settings.plugin-manager.endpoint-many',
    ));
  }

  if (websocketCount > 0) {
    parts.push(countLabel(
      websocketCount,
      'settings.plugin-manager.websocket-one',
      'settings.plugin-manager.websocket-many',
    ));
  }

  return parts;
}

function boundedError(value: string): string {
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

function permissionGranted(
  item: PluginListEntry,
  permission: PluginPermission,
): boolean {
  return item.permissionGrants?.[permission] ?? false;
}

function permissionLabel(permission: PluginPermission): string {
  return permission.endsWith(':write')
    ? hostT('settings.plugin-manager.persistent-rci-write')
    : hostT('settings.plugin-manager.persistent-rci-read');
}

type RuntimeState = NonNullable<PluginListEntry['runtime']>['state'];

function runtimeStateLabel(state: RuntimeState): string {
  switch (state) {
    case 'stopped':
      return hostT('settings.plugin-manager.runtime-state-stopped');
    case 'capacity_blocked':
      return hostT('settings.plugin-manager.runtime-state-capacity-blocked');
    case 'starting':
      return hostT('settings.plugin-manager.runtime-state-starting');
    case 'ready':
      return hostT('settings.plugin-manager.runtime-state-ready');
    case 'backoff':
      return hostT('settings.plugin-manager.runtime-state-backoff');
    case 'failed':
      return hostT('settings.plugin-manager.runtime-state-failed');
  }
}

let {
  items,
  confirmingName,
  rowStateFor = () => undefined,
  permissionVisible = false,
  permissionAvailable = false,
  onEnable,
  onDisable,
  onPermissionChange,
  onRestart = () => {},
  onDelete,
  onRequestConfirm,
  onCancelConfirm,
  onRefresh = () => {},
}: Props = $props();
</script>

<section
  class="mndw-installed"
  aria-labelledby="mndw-installed-title"
>
  <h3 id="mndw-installed-title">
    {hostT('settings.plugin-manager.installed-title')}
  </h3>

  {#if items.length === 0}
    <p class="mndw-installed__empty">
      {hostT('settings.plugin-manager.no-installed')}
    </p>
  {:else}
    <ul class="mndw-installed__list">
      {#each items as item (item.name)}
        {@const summary = backendSummary(item.backend)}
        {@const versionWarnings = getPluginVersionWarnings(item.name)}
        {@const deps = getDepsStatus(item.name)}
        {@const row = rowStateFor(item.name)}
        {@const busy = row?.state === 'working' || row?.state === 'reconciling'}
        <li class="mndw-installed__item">
          <div class="mndw-installed__identity">
            <strong>{item.label}</strong>
            <span>{item.name}</span>
          </div>

          <div class="mndw-installed__metadata">
            <span>
              {hostT('settings.plugin-manager.version')}: {item.version}</span>
            <span>
              {hostT('settings.plugin-manager.type')}: {item.type}</span>
            <span>
              {hostT('settings.plugin-manager.source')}: {item.source}</span>
            {#if item.source === 'builtin'}
              <span class="mndw-installed__builtin">
                {hostT('settings.plugin-manager.builtin')}
              </span>
            {/if}
            {#if deps === 'installing'}
              <span class="mndw-installed__deps-badge">
                {
                  hostT(
                    'settings.plugin-manager.installing-dependencies',
                  )
                }
              </span>
            {:else if deps === 'failed'}
              <span
                class="mndw-installed__deps-badge mndw-installed__deps-badge--failed"
              >
                {
                  hostT(
                    'settings.plugin-manager.dependency-install-failed',
                  )
                }
              </span>
            {/if}
            {#if versionWarnings.length > 0}
              <span class="mndw-installed__version-badge">
                {hostT('settings.plugin-manager.version-mismatch')}
              </span>
            {/if}
          </div>

          {#if versionWarnings.length > 0}
            <p class="mndw-installed__version-warning">
              {
                hostT(
                  'settings.plugin-manager.version-warning',
                  {
                    versions: versionWarnings.join(', '),
                  },
                )
              }
            </p>
          {/if}

          {#if summary.length > 0}
            <p class="mndw-installed__backend">{summary.join(', ')}</p>
          {/if}

          {#if permissionVisible}
            {#each PERSISTENT_RCI_PERMISSIONS as permission (permission)}
              {#if item.permissions?.includes(permission)}
                <mndw-field
                  class="mndw-installed__permission-switch"
                  label={permissionLabel(permission)}
                >
                  <mndw-switch
                    checked={permissionGranted(item, permission)}
                    disabled={busy
                    || (!permissionGranted(item, permission)
                      && !permissionAvailable)}
                    onmndwchange={(event: CustomEvent<{checked: boolean}>) =>
                    onPermissionChange(
                      item.name,
                      permission,
                      event.detail.checked,
                    )}
                  >
                  </mndw-switch>
                </mndw-field>
              {/if}
            {/each}
          {/if}

          {#if row !== undefined && row?.message !== ''}
            <div
              class="mndw-alert mndw-alert--danger"
              role="alert"
            >
              {row?.message}
              {#if row?.state === 'notice-finishing'}
                <mndw-button
                  class="mndw-installed__refresh"
                  variant="ghost"
                  onclick={onRefresh}
                >
                  {hostT('settings.plugin-manager.refresh')}
                </mndw-button>
              {/if}
            </div>
          {/if}

          {#if item.source !== 'builtin'}
            <div class="mndw-installed__actions">
              <mndw-button
                class="mndw-installed__toggle"
                variant="primary"
                disabled={busy}
                onclick={() =>
                item.enabled ? onDisable(item.name) : onEnable(item.name)}
              >
                {
                  item.enabled
                  ? hostT('settings.plugin-manager.disable')
                  : hostT('settings.plugin-manager.enable')
                }
              </mndw-button>
              {#if item.runtime && item.runtime.state !== 'stopped'}
                <mndw-button
                  class="mndw-installed__restart"
                  variant="secondary"
                  disabled={busy}
                  onclick={() => onRestart(item.name)}
                >
                  {hostT('settings.plugin-manager.restart-backend')}
                </mndw-button>
              {/if}
              {#if confirmingName === item.name}
                <div class="mndw-installed__confirmation">
                  <p>
                    {
                      hostT(
                        'settings.plugin-manager.delete-confirmation',
                        {label: item.label},
                      )
                    }
                  </p>
                  <mndw-button
                    class="mndw-installed__cancel"
                    variant="ghost"
                    disabled={busy}
                    onclick={onCancelConfirm}
                  >
                    {hostT('settings.plugin-manager.cancel')}
                  </mndw-button>
                  <mndw-button
                    class="mndw-installed__confirm"
                    variant="danger"
                    disabled={busy}
                    onclick={() => onDelete(item.name)}
                  >
                    {hostT('settings.plugin-manager.delete-plugin')}
                  </mndw-button>
                </div>
              {:else}
                <mndw-button
                  class="mndw-installed__delete"
                  variant="danger"
                  disabled={busy}
                  onclick={() => onRequestConfirm(item.name)}
                >
                  {hostT('settings.plugin-manager.delete')}
                </mndw-button>
              {/if}
            </div>
          {/if}

          {#if item.runtime}
            <p class="mndw-installed__runtime">
              {hostT('settings.plugin-manager.backend')}: {
                runtimeStateLabel(item.runtime.state)
              }
              {#if item.runtime.requiredProtocol !== undefined}
                <span>
                  · {hostT('settings.plugin-manager.protocol')} {
                    item.runtime.requiredProtocol
                  }</span>
              {/if}
              {#if item.runtime.compatible === false}
                <span class="mndw-installed__runtime-warning">
                  · {hostT('settings.plugin-manager.incompatible')}</span>
              {/if}
              {#if item.runtime.lastError}
                — {boundedError(item.runtime.lastError)}{/if}
            </p>
            {#if item.runtime.compatible === false
          && item.runtime.supportedProtocols}
              <p class="mndw-installed__runtime-warning">
                {
                  hostT(
                    'settings.plugin-manager.supported-service-protocols',
                  )
                }: {item.runtime.supportedProtocols.join(', ')}
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
