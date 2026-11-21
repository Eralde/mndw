<script lang="ts">
import {column} from '@mndw/ui';
import {svelteCell, svelteCellWith} from '@mndw/ui-svelte';
import type {ComponentProps} from 'svelte';
import {onMount} from 'svelte';
import {ServiceError} from '../../services/service-client.js';
import type {ServiceEntry} from '../../services/service-client.js';
import {confirmHost} from '../../services/overlay/host-overlay.js';
import {getHostServices} from '../../host-services-context.js';
import {appState} from '../../state/app.svelte.js';
import EmptyState from '../../components/EmptyState.svelte';
import ServiceNameCell from './ServiceNameCell.svelte';
import ServiceStateCell from './ServiceStateCell.svelte';
import type {ServiceRow} from './service-row.js';
import {
  type ServiceAction,
  serviceActionsRenderer,
} from './service-actions-renderer.svelte.js';
import {serviceAutostartRenderer} from './service-autostart-renderer.svelte.js';
import {observeCompactPanelWidth} from './panel-width.js';

let services = $state<ServiceEntry[]>([]);
let panelElement: HTMLElement;
let compactLayout = $state(false);
const hostServices = getHostServices();
const hostT = hostServices.locale.hostT;
const serviceClient = hostServices.serviceClient;
let rowErrors = $state<Record<string, boolean>>({});
let loading = $state(false);
let unavailable = $state(false);
let loadError = $state(false);
let busy = $state(false);
let rowGenerations = $state<Record<string, number>>({});
let generation = 0;
let controller: AbortController | undefined;

const MAX_CONCURRENT_PROBES = 3;

const rows = $derived.by<ServiceRow[]>(() =>
  services.map((service) => ({
    service,
    busy,
    rowError: rowErrors[service.name] ?? false,
    compact: compactLayout,
  }))
);

const serviceNameRenderer = svelteCellWith<
  ServiceRow,
  unknown,
  {onToggle: (enabled: boolean) => void},
  ComponentProps<typeof ServiceNameCell>
>(
  ServiceNameCell,
  (state) => ({
    onToggle: (enabled) => void toggleBoot(state.row.service, enabled),
  }),
);
const stateRenderer = svelteCell<ServiceRow>()(ServiceStateCell);
const autostartRenderer = serviceAutostartRenderer((service, enabled) =>
  void toggleBoot(service, enabled)
);
const actionsRenderer = serviceActionsRenderer((action: ServiceAction, name) =>
  void runAction(action, name)
);

const columns = $derived.by(() => [
  column<ServiceRow>()({
    id: 'service',
    label: hostT('services.service'),
    width: compactLayout ? '8rem' : '10rem',
    renderer: serviceNameRenderer,
  }),
  column<ServiceRow>()({
    id: 'state',
    label: hostT('services.state'),
    width: '7.1rem',
    renderer: stateRenderer,
  }),
  column<ServiceRow>()({
    id: 'autostart',
    label: hostT('services.autostart'),
    width: '6.7rem',
    align: 'center',
    renderer: autostartRenderer,
  }),
  column<ServiceRow>()({
    id: 'actions',
    label: hostT('services.actions'),
    width: compactLayout ? '7rem' : '18rem',
    renderer: actionsRenderer,
  }),
]);

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

async function confirm(
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  return confirmHost(hostServices.hostOverlay, {
    title: hostT('services.confirm-title'),
    message,
    confirmLabel,
    danger: true,
  });
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
  enabled: boolean,
): Promise<void> {
  if (busy || service.protected || service.autostartPinned) {
    return;
  }

  const previousName = service.name;

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

onMount(() => {
  void loadServices();
  const disconnectResizeObserver = observeCompactPanelWidth(
    panelElement,
    (compact) => {
      compactLayout = compact;
    },
  );

  return () => {
    disconnectResizeObserver();
    controller?.abort();
  };
});
</script>

<section
  bind:this={panelElement}
  class="services-panel"
  data-locale={appState.locale}
>
  <div
    class:compact={compactLayout}
    class="header-row mndw-table-controls"
  >
    <p>{hostT('services.description')}</p>
    <mndw-button
      variant="secondary"
      disabled={loading || busy}
      onclick={() => void loadServices()}
    >{hostT('services.refresh')}</mndw-button>
  </div>
  {#if unavailable}
    <div
      class="capability"
      role="status"
    >
      <strong>{hostT('services.unavailable')}</strong><span>{
        hostT('services.unavailable-description')
      }</span>
    </div>
  {:else if loadError}
    <div
      class="mndw-alert mndw-alert--danger services-load-error"
      role="alert"
    >
      <p>{hostT('services.load-failed')}</p>
      <mndw-button
        variant="secondary"
        onclick={() => void loadServices()}
      >{hostT('common.retry')}</mndw-button>
    </div>
  {:else if loading && services.length === 0}
    <p role="status">
      {hostT('packages.loading')}
    </p>
  {:else if !loading && services.length === 0}
    <EmptyState
      mode="compact"
      title={hostT('services.empty')}
      text={hostT('services.empty-next')}
      action={{label: hostT('services.refresh'),
      onActivate: () => void loadServices(), variant: 'secondary'}}
    />
  {:else}
    <div class="table-wrap">
      <mndw-table
        columns={columns}
        rows={rows}
        rowKey={(row: ServiceRow) => row.service.name}
        hiddenColumns={compactLayout ? ['state', 'autostart'] : []}
        min-width={compactLayout ? '' : '42rem'}
        columnMenu={false}
        rowLabel={(row: ServiceRow) => row.service.label}
        emptyLabel={hostT('services.empty')}
      ></mndw-table>
    </div>
  {/if}
</section>

<style>
.services-panel { min-width: 0; padding: 1rem; font-family: var(--mndw-font-sans); color: var(--mndw-text); max-width: 75rem; }
.header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }.header-row.compact { flex-wrap: wrap; gap: 0.5rem; }.header-row p { margin: 0; color: var(--mndw-text-subtle); font-size: .8125rem; }.header-row.compact p { min-width: 0; }
.table-wrap { min-width: 0; border: 1px solid var(--mndw-border); border-radius: 0.375rem; overflow: hidden; }
mndw-table { display: block; min-width: 0; font-size: .8125rem; }
mndw-table::part(viewport) { max-height: calc(100vh - 250px); overflow: auto; }
mndw-table::part(header-cell) { position: sticky; top: 0; z-index: 1; background: var(--mndw-surface); }
.capability { display: grid; gap: 0.5rem; padding: 2.5rem 1rem; text-align: center; color: var(--mndw-text-subtle); }.capability strong { color: var(--mndw-text); }
.services-load-error { display: grid; justify-items: center; gap: 0.5rem; }
.services-load-error p { margin: 0; }
</style>
