<script lang="ts">
import type {MndwSwitchChangeDetail} from '@mndw/ui';
import {onMount} from 'svelte';
import {ServiceError, serviceClient} from '../../services/service-client.js';
import type {ServiceEntry} from '../../services/service-client.js';
import {openHostModal} from '../../services/overlay/host-overlay.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';
import ConfirmActionModal from './ConfirmActionModal.svelte';

let services = $state<ServiceEntry[]>([]);
let rowErrors = $state<Record<string, boolean>>({});
let loading = $state(false);
let unavailable = $state(false);
let loadError = $state(false);
let busy = $state(false);
let rowGenerations = $state<Record<string, number>>({});
let generation = 0;
let controller: AbortController | undefined;

const MAX_CONCURRENT_PROBES = 3;

function replaceEntryByName(previousName: string, entry: ServiceEntry): void {
  services = services.map((candidate) =>
    candidate.name === previousName ? entry : candidate
  );
}

function replaceEntry(entry: ServiceEntry): void {
  replaceEntryByName(entry.name, entry);
}

// Runs `task` over `items` with at most `limit` in flight at once, using a
// shared cursor so each worker pulls the next item as it finishes.
async function pool<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];

      if (item !== undefined) {
        await task(item);
      }
    }
  };

  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, () => worker()),
  );
}

// A probe result is only applied while it is still current: same load batch,
// the row was not mutated by an action since we started, and not aborted.
// Reads live state on purpose — all three may change during the awaited probe.
function stillCurrent(
  name: string,
  batch: number,
  rowGeneration: number,
  signal: AbortSignal,
): boolean {
  return generation === batch
    && (rowGenerations[name] ?? 0) === rowGeneration
    && !signal.aborted;
}

async function probeRow(
  row: ServiceEntry,
  batch: number,
  signal: AbortSignal,
): Promise<void> {
  const rowGeneration = rowGenerations[row.name] ?? 0;

  try {
    const result = await serviceClient.status(row.name, signal);

    if (stillCurrent(row.name, batch, rowGeneration, signal)) {
      replaceEntry(result);
    }
  } catch {
    if (stillCurrent(row.name, batch, rowGeneration, signal)) {
      rowErrors = {...rowErrors, [row.name]: true};
    }
  }
}

async function probeRows(
  rows: ServiceEntry[],
  batch: number,
  signal: AbortSignal,
): Promise<void> {
  await pool(
    rows,
    MAX_CONCURRENT_PROBES,
    (row) => probeRow(row, batch, signal),
  );
}

async function loadServices(): Promise<void> {
  controller?.abort();

  controller = new AbortController();

  const batch = ++generation;

  loading = true;
  unavailable = false;
  loadError = false;
  rowErrors = {};
  rowGenerations = {};

  try {
    const rows = await serviceClient.list();

    if (generation !== batch) {
      return;
    }

    services = rows;
    loading = false;

    await probeRows(rows, batch, controller.signal);
  } catch (error) {
    if (generation !== batch || controller.signal.aborted) {
      return;
    }

    services = [];
    unavailable = error instanceof ServiceError
      && error.code === 'SERVICE_UNAVAILABLE';

    loadError = !unavailable;
    loading = false;
  } finally {
    if (generation === batch) {
      loading = false;
    }
  }
}

type ConfirmProps = {
  message: string;
  confirmLabel: string;
  close: (result: boolean) => void;
};

async function confirm(
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  const session = openHostModal<boolean, ConfirmProps>(ConfirmActionModal, {
    title: hostT('services.confirm-title'),
    props: {message, confirmLabel},
  });
  const event = await session.closed;
  return event.result === true;
}

async function confirmAction(
  action: 'stop' | 'restart',
  name: string,
): Promise<boolean> {
  return confirm(
    hostT('services.confirm', {action, name}),
    hostT(`services.${action}`),
  );
}

async function confirmBoot(name: string, enabled: boolean): Promise<boolean> {
  return confirm(
    hostT(
      enabled
        ? 'services.confirm-enable-boot'
        : 'services.confirm-disable-boot',
      {name},
    ),
    hostT(enabled ? 'services.enable-at-boot' : 'services.disable-at-boot'),
  );
}

async function runAction(
  action: 'start' | 'stop' | 'restart',
  name: string,
): Promise<void> {
  if (busy) {
    return;
  }

  if (
    (action === 'stop' || action === 'restart')
    && !(await confirmAction(action, name))
  ) {
    return;
  }

  rowGenerations = {...rowGenerations, [name]: (rowGenerations[name] ?? 0) + 1};
  busy = true;

  try {
    const result = await serviceClient[action](name);

    replaceEntry(result.service);

    rowErrors = {...rowErrors, [name]: false};
  } catch {
    rowErrors = {...rowErrors, [name]: true};
  } finally {
    busy = false;
  }
}

async function toggleBoot(
  service: ServiceEntry,
  event: CustomEvent<MndwSwitchChangeDetail>,
): Promise<void> {
  if (busy || service.protected || service.autostartPinned) {
    return;
  }

  const switchControl = event.currentTarget as HTMLElement & {checked: boolean};

  switchControl.checked = service.enabledAtBoot;

  const previousName = service.name;
  const enabled = !service.enabledAtBoot;

  if (!(await confirmBoot(previousName, enabled))) {
    return;
  }

  rowGenerations = {
    ...rowGenerations,
    [previousName]: (rowGenerations[previousName] ?? 0) + 1,
  };

  busy = true;

  try {
    const result = await serviceClient.setEnabled(previousName, enabled);

    replaceEntryByName(previousName, result.service);

    rowErrors = {...rowErrors, [previousName]: false};
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'CONFLICT') {
      replaceEntryByName(previousName, {...service, autostartPinned: true});

      rowErrors = {...rowErrors, [previousName]: false};
    } else {
      rowErrors = {...rowErrors, [previousName]: true};
    }
  } finally {
    busy = false;
  }
}

function stateLabel(service: ServiceEntry): string {
  return rowErrors[service.name]
    ? hostT('services.probe-failed')
    : service.state;
}

function bootDisabled(service: ServiceEntry): boolean {
  return busy || service.protected || service.autostartPinned;
}

function bootAriaLabel(service: ServiceEntry): string {
  return service.enabledAtBoot
    ? hostT('services.disable-at-boot')
    : hostT('services.enable-at-boot');
}

function bootTitle(service: ServiceEntry): string {
  if (service.protected) {
    return hostT('services.protected');
  }

  if (service.autostartPinned) {
    return hostT('services.autostart-pinned');
  }

  return bootAriaLabel(service);
}

function protectedTitle(service: ServiceEntry): Record<string, string> {
  return service.protected ? {title: hostT('services.protected')} : {};
}

const rowActions = [
  {action: 'start', label: 'services.start', guardProtected: false},
  {action: 'stop', label: 'services.stop', guardProtected: true},
  {action: 'restart', label: 'services.restart', guardProtected: true},
] as const;

onMount(() => {
  void loadServices();
  return () => controller?.abort();
});
</script>

<section
  class="services-panel"
  data-locale={appState.locale}
>
  <div class="header-row">
    <div>
      <h1>{hostT('services.title')}</h1>
      <p>{hostT('services.description')}</p>
    </div>
    <mndw-button
      variant="secondary"
      disabled={loading || busy}
      onclick={() => void loadServices()}
    >{hostT('services.refresh')}</mndw-button>
  </div>
  {#if unavailable}
    <div
      class="empty capability"
      role="status"
    >
      <strong>{hostT('services.unavailable')}</strong><span>{
        hostT('services.unavailable-description')
      }</span>
    </div>
  {:else if loadError}
    <div
      class="empty"
      role="status"
    >
      {hostT('services.load-failed')}
    </div>
  {:else if !loading && services.length === 0}
    <div
      class="empty"
      role="status"
    >
      {hostT('services.empty')}
    </div>
  {:else}
    <div class="table-wrap">
      <table>
        <colgroup>
          <col class="service-column" />
          <col class="state-column" />
          <col class="autostart-column" />
          <col class="actions-column" />
        </colgroup>
        <thead>
          <tr>
            <th>{hostT('services.service')}</th>
            <th>{hostT('services.state')}</th>
            <th class="autostart">{hostT('services.autostart')}</th>
            <th>{hostT('services.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {#each services as service (service.name)}
            <tr>
              <td>
                <strong>{service.label}</strong><small>{service.name}</small>
              </td>
              <td>
                <span class="badge badge-{service.state}">
                  {stateLabel(service)}
                </span>
                {#if service.pid !== undefined}
                  <small class="pid">
                    {hostT('services.pid', {pid: service.pid})}
                  </small>
                {/if}
              </td>
              <td class="autostart">
                <mndw-switch
                  checked={service.enabledAtBoot}
                  disabled={bootDisabled(service)}
                  aria-label={bootAriaLabel(service)}
                  title={bootTitle(service)}
                  onmndwchange={(event: CustomEvent<MndwSwitchChangeDetail>) =>
                  void toggleBoot(service, event)}
                >
                </mndw-switch>
              </td>
              <td class="actions">
                {#each rowActions as {action, label, guardProtected} (action)}
                  <mndw-button
                    variant="secondary"
                    disabled={busy || (guardProtected && service.protected)}
                    {...(guardProtected ? protectedTitle(service) : {})}
                    onclick={() => void runAction(action, service.name)}
                  >{hostT(label)}</mndw-button>
                {/each}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
.services-panel { padding: 1rem; font-family: var(--mndw-font-sans); color: var(--mndw-text); max-width: 75rem; }
.header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; }.header-row h1 { margin: 0; font-size: 1.25rem; }.header-row p { margin: 0.25rem 0 0; color: var(--mndw-text-subtle); font-size: .8125rem; }
.table-wrap { overflow: auto; border: 1px solid var(--mndw-border); border-radius: 0.375rem; }.empty { display: grid; gap: 0.5rem; padding: 2.5rem 1rem; text-align: center; color: var(--mndw-text-subtle); }.capability strong { color: var(--mndw-text); }
table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: .8125rem; } .service-column { width: 24%; } .state-column { width: 17%; } .autostart-column { width: 16%; } .actions-column { width: 43%; } th, td { padding: 0.5rem 0.625rem; text-align: left; border-bottom: 1px solid var(--mndw-border); } th { color: var(--mndw-text-muted); } tr:last-child td { border-bottom: 0; } td small { display: block; color: var(--mndw-text-subtle); }.actions { white-space: nowrap; }.actions mndw-button { margin-right: 0.25rem; }
.autostart { text-align: center; }
.badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 0.625rem; text-transform: capitalize; font-size: .75rem; }.badge-running { color: var(--mndw-success); }.badge-stopped { color: var(--mndw-warning); }.badge-unknown { color: var(--mndw-text-subtle); }
</style>
