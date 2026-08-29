<script lang="ts">
import {onMount} from 'svelte';
import {SvelteMap} from 'svelte/reactivity';

import {appState} from '../../../state/app.svelte.js';
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import {
  type MgmtClient,
  type RuntimeLimits,
  classifyMutationFailure,
  messageForError,
  mgmtClient,
} from '../../../services/mgmt-client.js';
import InstalledPluginList from './InstalledPluginList.svelte';
import PendingApprovals from './PendingApprovals.svelte';
import PluginUpload from './PluginUpload.svelte';
import {
  type LifecycleOp,
  type PluginRowState,
  expectedStateReached,
  reconcile,
} from './reconcile.js';

interface Props {
  client?: MgmtClient;
  permissionVisible?: boolean;
  permissionAvailable?: boolean;
}

let {
  client = mgmtClient,
  permissionVisible = false,
  permissionAvailable = false,
}: Props = $props();
let plugins = $state<PluginListEntry[]>([]);
let runtimeLimits = $state<RuntimeLimits | null>(null);
let runtimeError = $state('');
let loading = $state(true);
let loadError = $state('');
let refreshError = $state('');
let confirmingName = $state<string | null>(null);
let reloadPrompt = $state(false);
let latestRequest = 0;
const rowStates = new SvelteMap<string, PluginRowState>();
const RECONCILE_OPTIONS = {polls: 3, intervalMs: 1000};
let installed = $derived.by(() => {
  return plugins.filter((plugin) => plugin.approval === 'approved');
});
let pending = $derived.by(() => {
  return plugins.filter((plugin) => plugin.approval === 'pending');
});

function rowStateFor(name: string): PluginRowState | undefined {
  return rowStates.get(name);
}

function clearSatisfiedNotices(list: PluginListEntry[]): void {
  for (const [name, row] of rowStates) {
    if (
      row.state === 'notice-finishing' && row.operation !== undefined
      && expectedStateReached(row.operation, name, list)
    ) {
      rowStates.delete(name);
    }
  }
}

async function load(): Promise<void> {
  const request = ++latestRequest;
  loading = true;
  loadError = '';

  try {
    const listed = await client.listPlugins();
    if (request === latestRequest) {
      plugins = listed;
      refreshError = '';
      clearSatisfiedNotices(listed);
    }
  } catch (caught) {
    if (request === latestRequest) {
      loadError = messageForError(caught);
    }
  } finally {
    if (request === latestRequest) {
      loading = false;
    }
  }
}

async function refresh(): Promise<void> {
  const request = ++latestRequest;

  try {
    const listed = await client.listPlugins();
    if (request === latestRequest) {
      plugins = listed;
      loadError = '';
      refreshError = '';
      loading = false;
      clearSatisfiedNotices(listed);
    }
  } catch (caught) {
    if (request === latestRequest) {
      refreshError = messageForError(caught);
      loading = false;
    }
  }

  void loadRuntime();
}

async function loadRuntime(): Promise<void> {
  try {
    runtimeLimits = await client.getRuntime();
    runtimeError = '';
  } catch (caught) {
    runtimeError = messageForError(caught);
  }
}

async function mutate(
  name: string,
  operation: LifecycleOp,
  run: () => Promise<unknown>,
  reload: boolean,
): Promise<boolean> {
  const existing = rowStates.get(name);

  if (existing?.state === 'working' || existing?.state === 'reconciling') {
    return false;
  }

  rowStates.set(name, {state: 'working', message: '', operation});
  let succeeded = false;

  try {
    await run();
    succeeded = true;
    rowStates.delete(name);
    if (reload) {
      reloadPrompt = true;
    }
    await refresh();
  } catch (caught) {
    const outcome = classifyMutationFailure(caught);

    if (outcome === 'rejected-maintenance') {
      rowStates.set(name, {
        state: 'notice-rejected',
        message: hostT('settings.plugin-manager.maintenance-busy'),
        operation,
      });
    } else if (outcome === 'ambiguous') {
      rowStates.set(name, {
        state: 'reconciling',
        message: hostT('settings.plugin-manager.confirming-state'),
        operation,
      });

      try {
        const result = await reconcile(
          operation,
          name,
          () => client.listPlugins(),
          RECONCILE_OPTIONS,
        );

        if (result === 'ok') {
          rowStates.delete(name);
          succeeded = true;
          if (reload) {
            reloadPrompt = true;
          }
          await refresh();
        } else if (result === 'notice-finishing') {
          rowStates.set(name, {
            state: 'notice-finishing',
            message: hostT('settings.plugin-manager.operation-finishing'),
            operation,
          });
        } else {
          rowStates.set(name, {
            state: 'outcome-unknown',
            message: hostT('settings.plugin-manager.outcome-unknown'),
            operation,
          });
        }
      } catch (reconcileError) {
        rowStates.set(name, {
          state: 'outcome-unknown',
          message: messageForError(reconcileError),
          operation,
        });
      }
    } else {
      rowStates.set(name, {state: 'error', message: messageForError(caught),
        operation});
      await refresh();
    }
  } finally {
    confirmingName = null;
  }

  return succeeded;
}

function onInstalled(): void {
  reloadPrompt = true;
  void refresh();
}

function dismissed(): void {
  void refresh();
}

onMount(() => {
  void load();
  void loadRuntime();
});
</script>

<section class="mndw-plugin-manager">
  <h3>{hostT('settings.plugin-manager.title')}</h3>

  {#if reloadPrompt}
    <div
      class="mndw-reload"
      role="status"
    >
      <span>{hostT('settings.plugin-manager.reload-notice')}</span>
      <mndw-button
        variant="primary"
        onclick={() => window.location.reload()}
      >
        {hostT('settings.plugin-manager.reload-now')}
      </mndw-button>
      <mndw-button
        variant="ghost"
        onclick={() => (reloadPrompt = false)}
      >
        {hostT('settings.plugin-manager.later')}
      </mndw-button>
    </div>
  {/if}

  <PluginUpload
    architecture={appState.hostInfo?.architecture}
    uploadFile={(file) => client.uploadPlugin(file)}
    {onInstalled}
    onApprove={(name) =>
    mutate(
      name,
      {kind: 'approve'},
      () => client.approvePlugin(name),
      true,
    )}
    onDeny={(name) =>
    mutate(name, {kind: 'deny'}, () => client.denyPlugin(name), false)}
    onDismiss={dismissed}
  />

  {#if loading}
    <p
      class="mndw-plugin-manager__loading"
      role="status"
    >
      {hostT('settings.plugin-manager.loading')}
    </p>
  {:else if loadError}
    <div
      class="mndw-alert mndw-alert--danger mndw-plugin-manager__notice"
      role="alert"
    >
      <p>{loadError}</p>
      <mndw-button
        variant="secondary"
        onclick={() => void load()}
      >
        {hostT('settings.plugin-manager.retry')}
      </mndw-button>
    </div>
  {:else}
    {#if refreshError}
      <div
        class="mndw-alert mndw-alert--danger mndw-plugin-manager__notice"
        role="alert"
      >
        <span>{refreshError}</span>
        <mndw-button
          variant="ghost"
          onclick={() => (refreshError = '')}
        >
          {hostT('settings.plugin-manager.dismiss')}
        </mndw-button>
      </div>
    {/if}

    {#if runtimeLimits}
      <section
        class="mndw-runtime-capacity"
        aria-label={hostT('settings.backend-capacity')}
      >
        <strong>{hostT('settings.backend-capacity')}</strong>
        <span>
          {hostT('settings.plugin-manager.exec')}:
          {runtimeLimits.currentExec}/{runtimeLimits.maxConcurrentExecTotal}
        </span>
        <span>
          {hostT('settings.plugin-manager.services')}:
          {runtimeLimits.reservedServices}/{runtimeLimits.maxSupervisedServices}
        </span>
        <span>
          {hostT('settings.plugin-manager.per-plugin-exec-limit')}:
          {runtimeLimits.maxConcurrentExecPerPlugin}
        </span>
        <span>
          {hostT('settings.plugin-manager.service-protocols')}:
          {runtimeLimits.supportedServiceProtocols.join(', ')}
        </span>
      </section>
    {:else if runtimeError}
      <p class="mndw-plugin-manager__runtime-error">
        {
          hostT('settings.plugin-manager.runtime-status-unavailable', {
            error: runtimeError,
          })
        }
      </p>
    {/if}

    {#if pending.length > 0}
      <PendingApprovals
        items={pending}
        {confirmingName}
        {rowStateFor}
        onApprove={(name) =>
        mutate(
          name,
          {kind: 'approve'},
          () => client.approvePlugin(name),
          true,
        )}
        onDeny={(name) =>
        mutate(name, {kind: 'deny'}, () => client.denyPlugin(name), false)}
        onRequestConfirm={(name) => (confirmingName = name)}
        onCancelConfirm={() => (confirmingName = null)}
        onRefresh={() => void refresh()}
      />
    {/if}

    <InstalledPluginList
      items={installed}
      {confirmingName}
      {rowStateFor}
      {permissionVisible}
      {permissionAvailable}
      onEnable={(name) =>
      mutate(name, {kind: 'enable'}, () => client.enablePlugin(name), true)}
      onDisable={(name) =>
      mutate(
        name,
        {kind: 'disable'},
        () => client.disablePlugin(name),
        true,
      )}
      onPermissionChange={(name, permission, enabled) =>
      mutate(name, {kind: 'permission', permission, enabled}, () =>
        client.setPluginPermission(name, permission, enabled), false)}
      onRestart={(name) =>
      mutate(name, {kind: 'restart'}, () =>
        client.restartPlugin(name), false)}
      onDelete={(name) =>
      mutate(name, {kind: 'delete'}, () => client.deletePlugin(name), true)}
      onRequestConfirm={(name) => (confirmingName = name)}
      onCancelConfirm={() => (confirmingName = null)}
      onRefresh={() => void refresh()}
    />
  {/if}
</section>

<style>
.mndw-plugin-manager {
  display: grid;
  gap: var(--mndw-space-4);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.mndw-plugin-manager h3,
.mndw-plugin-manager p {
  margin: 0;
}

.mndw-plugin-manager h3 {
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-reload {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mndw-space-2);
  padding: var(--mndw-space-3);
  border: 1px solid var(--mndw-accent);
  border-radius: var(--mndw-radius-sm);
  font-size: var(--mndw-text-sm);
}

.mndw-runtime-capacity {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.mndw-runtime-capacity strong {
  color: var(--mndw-text);
}

.mndw-plugin-manager__runtime-error {
  color: var(--mndw-warning);
  font-size: var(--mndw-text-sm);
}

/* Layout only. `.mndw-alert--danger` owns the box and the severity colours. */
.mndw-plugin-manager__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mndw-space-2);
  font-size: var(--mndw-text-sm);
}
</style>
