<script lang="ts">
import {onMount} from 'svelte';

import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {
  type MgmtClient,
  messageForError,
  mgmtClient,
} from '../../../services/mgmt-client.js';
import InstalledPluginList from './InstalledPluginList.svelte';
import PendingApprovals from './PendingApprovals.svelte';
import PluginUpload from './PluginUpload.svelte';

interface Props {
  client?: MgmtClient;
}

let {client = mgmtClient}: Props = $props();
let plugins = $state<PluginListEntry[]>([]);
let loading = $state(true);
let loadError = $state('');
let refreshError = $state('');
let busyName = $state<string | null>(null);
let confirmingName = $state<string | null>(null);
let actionError = $state<{name: string; message: string} | null>(null);
let reloadPrompt = $state(false);
let latestRequest = 0;
let installed = $derived(
  plugins.filter((plugin) => plugin.approval === 'approved'),
);
let pending = $derived(
  plugins.filter((plugin) => plugin.approval === 'pending'),
);

async function load(): Promise<void> {
  const request = ++latestRequest;
  loading = true;
  loadError = '';

  try {
    const listed = await client.listPlugins();
    if (request === latestRequest) {
      plugins = listed;
      refreshError = '';
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
    }
  } catch (caught) {
    if (request === latestRequest) {
      refreshError = messageForError(caught);
      loading = false;
    }
  }
}

async function mutate(
  name: string,
  run: () => Promise<unknown>,
  reload: boolean,
): Promise<boolean> {
  if (busyName !== null) {
    return false;
  }

  busyName = name;
  actionError = null;
  let succeeded = false;

  try {
    await run();
    succeeded = true;
    if (reload) {
      reloadPrompt = true;
    }
  } catch (caught) {
    actionError = {name, message: messageForError(caught)};
  } finally {
    await refresh();
    busyName = null;
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
});
</script>

<section class="mndw-plugin-manager">
  <h2>Plugin manager</h2>

  {#if reloadPrompt}
    <div
      class="mndw-reload"
      role="status"
    >
      <span>Reload to apply plugin changes.</span>
      <button
        type="button"
        onclick={() => window.location.reload()}
      >
        Reload now
      </button>
      <button
        type="button"
        onclick={() => (reloadPrompt = false)}
      >
        Later
      </button>
    </div>
  {/if}

  <PluginUpload
    uploadFile={(file) => client.uploadPlugin(file)}
    {onInstalled}
    onApprove={(name) => mutate(name, () => client.approvePlugin(name), true)}
    onDeny={(name) => mutate(name, () => client.denyPlugin(name), false)}
    onDismiss={dismissed}
  />

  {#if loading}
    <p
      class="mndw-plugin-manager__loading"
      role="status"
    >
      Loading plugins...
    </p>
  {:else if loadError}
    <div
      class="mndw-alert mndw-alert--danger mndw-plugin-manager__notice"
      role="alert"
    >
      <p>{loadError}</p>
      <button
        type="button"
        onclick={() => void load()}
      >
        Retry
      </button>
    </div>
  {:else}
    {#if refreshError}
      <div
        class="mndw-alert mndw-alert--danger mndw-plugin-manager__notice"
        role="alert"
      >
        <span>{refreshError}</span>
        <button
          type="button"
          onclick={() => (refreshError = '')}
        >
          Dismiss
        </button>
      </div>
    {/if}

    {#if pending.length > 0}
      <PendingApprovals
        items={pending}
        {busyName}
        {confirmingName}
        {actionError}
        onApprove={(name) => mutate(name, () => client.approvePlugin(name), true)}
        onDeny={(name) => mutate(name, () => client.denyPlugin(name), false)}
        onRequestConfirm={(name) => (confirmingName = name)}
        onCancelConfirm={() => (confirmingName = null)}
      />
    {/if}

    <InstalledPluginList
      items={installed}
      {busyName}
      {confirmingName}
      {actionError}
      onEnable={(name) => mutate(name, () => client.enablePlugin(name), true)}
      onDisable={(name) => mutate(name, () => client.disablePlugin(name), true)}
      onDelete={(name) => mutate(name, () => client.deletePlugin(name), true)}
      onRequestConfirm={(name) => (confirmingName = name)}
      onCancelConfirm={() => (confirmingName = null)}
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

.mndw-plugin-manager h2,
.mndw-plugin-manager p {
  margin: 0;
}

.mndw-plugin-manager h2 {
  font-size: var(--mndw-text-xl);
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

/* Layout only. `.mndw-alert--danger` owns the box and the severity colours. */
.mndw-plugin-manager__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mndw-space-2);
  font-size: var(--mndw-text-sm);
}

.mndw-reload button,
.mndw-plugin-manager__notice button {
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-2) var(--mndw-space-3);
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
  font: inherit;
  cursor: pointer;
}
</style>
