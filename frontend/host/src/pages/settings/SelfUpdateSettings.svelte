<script lang="ts">
import {onDestroy, onMount} from 'svelte';
import {
  type SelfUpdateClient,
  SelfUpdateError,
  type SelfUpdateStatus,
  selfUpdateClient,
} from '../../services/self-update-client.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';

interface Props {
  client?: SelfUpdateClient;
  pollIntervalMs?: number;
  pollAttempts?: number;
}

type Outcome =
  | 'idle'
  | 'checking'
  | 'preparing'
  | 'busy'
  | 'error'
  | 'success'
  | 'failure'
  | 'unconfirmed';

let {
  client: providedClient,
  pollIntervalMs = 2_000,
  pollAttempts = 90,
}: Props = $props();

let client = $derived(providedClient || selfUpdateClient);

let status = $state<SelfUpdateStatus | null>(null);
let checked = $state<Awaited<ReturnType<SelfUpdateClient['check']>> | null>(
  null,
);

let acceptedTarget = $state('');
let acceptedOperation = $state<'update' | 'revert' | ''>('');
let outcome = $state<Outcome>('idle');
let failureCode = $state('');
let loading = $state(false);
let pollTimer: number | null = null;
let pollGeneration = 0;
let remainingPolls = 0;
let destroyed = false;
let awaitingCompletion = false;

onMount(() => {
  void loadInitialStatus();
});

onDestroy(() => {
  destroyed = true;

  stopPolling();
});

function stopPolling(): void {
  pollGeneration += 1;

  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);

    pollTimer = null;
  }
}

function setStatus(next: SelfUpdateStatus): void {
  status = next;

  if (next.state === 'failed') {
    failureCode = next.failureCode ?? 'unknown';
    outcome = 'failure';
    awaitingCompletion = false;
  } else if (next.state === 'idle' && awaitingCompletion) {
    outcome = 'success';
  } else if (next.state === 'in-progress') {
    outcome = 'idle';
  }
}

async function loadInitialStatus(): Promise<void> {
  loading = true;

  try {
    const next = await client.status();

    if (destroyed) {
      return;
    }

    setStatus(next);

    if (next.state === 'in-progress') {
      awaitingCompletion = true;
      startPolling();
    }
  } catch {
    outcome = 'error';
  } finally {
    loading = false;
  }
}

function startPolling(): void {
  stopPolling();

  remainingPolls = Math.max(0, pollAttempts);

  if (remainingPolls === 0) {
    outcome = 'unconfirmed';

    return;
  }

  const generation = pollGeneration;

  schedulePoll(generation);
}

function schedulePoll(generation: number): void {
  if (destroyed || generation !== pollGeneration || remainingPolls <= 0) {
    return;
  }

  pollTimer = window.setTimeout(
    () => {
      pollTimer = null;
      void pollStatus(generation);
    },
    pollIntervalMs,
  );
}

async function pollStatus(generation: number): Promise<void> {
  if (destroyed || generation !== pollGeneration) {
    return;
  }

  remainingPolls -= 1;

  try {
    const next = await client.status();

    if (destroyed || generation !== pollGeneration) {
      return;
    }

    setStatus(next);

    if (next.state === 'in-progress') {
      schedulePoll(generation);
    } else {
      stopPolling();
    }
  } catch {
    if (remainingPolls <= 0) {
      outcome = 'unconfirmed';

      return;
    }

    schedulePoll(generation);
  }
}

function errorCode(error: unknown): string {
  return error instanceof SelfUpdateError ? error.code : 'UNKNOWN';
}

async function recoverBusy(): Promise<void> {
  try {
    const next = await client.status();

    if (destroyed) {
      return;
    }

    setStatus(next);

    if (next.state === 'in-progress') {
      awaitingCompletion = true;

      startPolling();
    } else {
      outcome = 'busy';
    }
  } catch {
    outcome = 'busy';
  }
}

async function handleCheck(): Promise<void> {
  stopPolling();

  awaitingCompletion = false;
  loading = true;
  outcome = 'checking';
  failureCode = '';

  try {
    checked = await client.check();
    outcome = 'idle';
  } catch (error) {
    checked = null;

    if (errorCode(error) === 'OPKG_BUSY') {
      await recoverBusy();
    } else {
      outcome = 'error';
    }
  } finally {
    loading = false;
  }
}

async function handleApply(): Promise<void> {
  await beginAction('update', () => client.apply());
}

async function handleRevert(): Promise<void> {
  await beginAction('revert', () => client.revert());
}

async function beginAction(
  operation: 'update' | 'revert',
  action: () => ReturnType<SelfUpdateClient['apply']>,
): Promise<void> {
  stopPolling();
  checked = null;
  acceptedTarget = '';
  acceptedOperation = operation;
  failureCode = '';
  loading = true;
  outcome = 'preparing';
  awaitingCompletion = false;
  try {
    const accepted = await action();
    acceptedTarget = accepted.targetVersion;
    acceptedOperation = accepted.operation;
    outcome = 'idle';
    awaitingCompletion = true;
    startPolling();
  } catch (error) {
    checked = null;
    if (errorCode(error) === 'OPKG_BUSY') {
      await recoverBusy();
    } else if (errorCode(error) === 'SELF_UPDATE_NOT_AVAILABLE') {
      outcome = 'error';
      failureCode = 'no-update';
    } else if (errorCode(error) === 'SELF_UPDATE_ROLLBACK_UNAVAILABLE') {
      outcome = 'error';
      failureCode = 'rollback-unavailable';
    } else {
      outcome = 'error';
    }
  } finally {
    loading = false;
  }
}

function failureMessage(code: string): string {
  const keys: Record<string, string> = {
    'update-missing': 'settings.self-update-failure-update-missing',
    'opkg-install-failed': 'settings.self-update-failure-opkg-install-failed',
    'opkg-revert-failed': 'settings.self-update-failure-opkg-revert-failed',
    'rollback-missing': 'settings.self-update-failure-rollback-missing',
    'helper-exited': 'settings.self-update-failure-helper-exited',
    'unexpected-version': 'settings.self-update-failure-unexpected-version',
    'state-corrupt': 'settings.self-update-failure-state-corrupt',
  };
  return hostT(keys[code] ?? 'settings.self-update-failure-generic');
}

const currentVersion = $derived(status?.version ?? '');
const displayedTarget = $derived.by(() => {
  return status?.state === 'in-progress'
    ? acceptedTarget || status.targetVersion || ''
    : checked?.targetVersion || '';
});

const rollbackVersion = $derived.by(() => {
  return checked?.rollbackVersion || status?.rollbackVersion || '';
});

const canApply = $derived(checked?.updateAvailable === true && !loading);
const canRevert = $derived.by(() => {
  return (checked?.rollbackAvailable === true
    || Boolean(status?.rollbackVersion))
    && !loading;
});
</script>

<section
  class="mndw-self-update-settings"
  data-locale={appState.locale}
  aria-label={hostT('settings.self-update-tab')}
>
  <h3>{hostT('settings.self-update-tab')}</h3>
  <p>{hostT('settings.self-update-description')}</p>

  {#if currentVersion}
    <p>{hostT('settings.self-update-current', {version: currentVersion})}</p>
  {/if}
  {#if rollbackVersion}
    <p>{hostT('settings.self-update-rollback', {version: rollbackVersion})}</p>
  {/if}

  {#if outcome === 'checking'}
    <p role="status">{hostT('settings.self-update-checking')}</p>
  {:else if outcome === 'preparing'}
    <p role="status">{hostT('settings.self-update-preparing')}</p>
  {:else if status?.state === 'in-progress'}
    <p role="status">
      {
        hostT(
          acceptedOperation === 'revert' || status.operation === 'revert'
            ? 'settings.self-update-reverting'
            : 'settings.self-update-updating',
          {version: displayedTarget},
        )
      }
    </p>
  {:else if outcome === 'success'}
    <p role="status">
      {hostT('settings.self-update-success', {version: currentVersion})}
    </p>
  {:else if outcome === 'failure'}
    <p role="alert">{failureMessage(failureCode)}</p>
  {:else if outcome === 'unconfirmed'}
    <p role="alert">{hostT('settings.self-update-unconfirmed')}</p>
  {:else if outcome === 'busy'}
    <p role="alert">{hostT('settings.self-update-busy')}</p>
  {:else if outcome === 'error' && failureCode === 'no-update'}
    <p role="alert">{hostT('settings.self-update-no-update')}</p>
  {:else if outcome === 'error' && failureCode === 'rollback-unavailable'}
    <p role="alert">{hostT('settings.self-update-rollback-unavailable')}</p>
  {:else if outcome === 'error'}
    <p role="alert">{hostT('settings.self-update-failure-generic')}</p>
  {/if}

  {#if checked !== null && checked.updateAvailable
      && checked.targetVersion !== undefined}
    <p>
      {
        hostT('settings.self-update-available', {
          version: checked.targetVersion,
        })
      }
    </p>
  {/if}

  <div class="mndw-self-update-actions">
    <mndw-button
      variant="secondary"
      disabled={loading}
      onclick={() => void handleCheck()}
    >
      {
        outcome === 'checking'
        ? hostT('settings.self-update-checking')
        : hostT('settings.self-update-check')
      }
    </mndw-button>
    <mndw-button
      variant="primary"
      disabled={!canApply}
      onclick={() => void handleApply()}
    >
      {hostT('settings.self-update-apply')}
    </mndw-button>
    <mndw-button
      variant="secondary"
      disabled={!canRevert}
      onclick={() => void handleRevert()}
    >
      {hostT('settings.self-update-revert')}
    </mndw-button>
  </div>
</section>

<style>
.mndw-self-update-settings {
  display: grid;
  gap: var(--mndw-space-2);
}

.mndw-self-update-settings h3,
.mndw-self-update-settings p {
  margin: 0;
}

.mndw-self-update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
}
</style>
