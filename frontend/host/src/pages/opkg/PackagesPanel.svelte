<script lang="ts">
import {
  type MndwRowExpandDetail,
  type MndwSelectionChangeDetail,
  type MndwSortChangeDetail,
  type MndwTable,
  type SortState,
  column,
} from '@mndw/ui';
import {svelteCell} from '@mndw/ui-svelte';
import {onDestroy, onMount, tick} from 'svelte';
import {untrack} from 'svelte';
import {SvelteMap, SvelteSet} from 'svelte/reactivity';
import {
  OpkgError,
  dependencyConflictDetail,
} from '../../services/opkg-client.js';
import type {PackageEntry} from '../../services/opkg-client.js';
import {toast} from '../../services/toast/toast.svelte.js';
import {openHostModal} from '../../services/overlay/host-overlay.js';
import {getHostServices} from '../../host-services-context.js';
import {appState} from '../../state/app.svelte.js';
import {HOST_PATHS} from '../../router/host-routes.js';
import PackageNameCell from './PackageNameCell.svelte';
import PackageVersionCell from './PackageVersionCell.svelte';
import PackageStatusCell from './PackageStatusCell.svelte';
import {packageActionsRenderer} from './package-actions-renderer.svelte.js';
import {isProtectedPackage} from './package-protection.js';
import type {
  PackageCellRow,
  PackageRowAction,
} from './package-actions-renderer.svelte.js';
import {packageDetailRenderer} from './package-detail-renderer.svelte.js';
import type {
  PackageDetailCache,
  PackageDetailState,
} from './PackageDetailCell.svelte';
import {compareVersions} from './compare-versions.js';
import ConfirmActionModal from './ConfirmActionModal.svelte';
import EmptyState from '../../components/EmptyState.svelte';
import {observeCompactPanelWidth} from './panel-width.js';

interface Props {
  now?: () => Date;
}

interface ActionFocusTarget {
  packageName: string;
  source: 'primary' | 'detail';
}

type PackageAction = 'install' | 'remove' | 'upgrade';

interface PackageRow extends PackageEntry {
  busyAction?: PackageAction;
  actionsDisabled: boolean;
  compact: boolean;
}

const PACKAGE_LIST_TOAST_KEY = 'packages.list';
const PACKAGE_REFRESH_TOAST_KEY = 'packages.refresh';

function packageActionToastKey(
  action: 'install' | 'remove' | 'upgrade',
): string {
  return `packages.${action}`;
}

let {now = () => new Date()}: Props = $props();
let panelElement: HTMLElement;
let compactLayout = $state(false);
const hostServices = getHostServices();
const hostT = hostServices.locale.hostT;
const opkgClient = hostServices.opkgClient;
let packages = $state<PackageEntry[]>([]);
let metadataUpdatedAt = $state<string | null>(null);
let freshnessComputedAt = $state<Date | null>(null);
let checked = new SvelteSet<string>();
let filter = $state('');
let filterMode = $state<'all' | 'installed' | 'updates'>('installed');
let filterVersion = $state(0);
let listLoading = $state(true);
let checking = $state(false);
let busyAction = $state<PackageAction | null>(null);
let busyNames = new SvelteSet<string>();
let loadError = $state(false);
let loadErrorMessage = $state('');
let tableElement = $state<MndwTable<unknown> | null>(null);
let searchInput: HTMLElement | undefined;
let filterSequence = 0;
let destroyed = false;

onDestroy(() => {
  destroyed = true;
});

// @dprint-ignore
const detailCache: PackageDetailCache = new SvelteMap<string, PackageDetailState>();

let detailGeneration = 0;

const opkgBusy = $derived(checking || busyNames.size > 0);
const rows = $derived.by(() =>
  packages.map((pkg): PackageRow => ({
    ...pkg,
    ...(busyNames.has(pkg.name) && busyAction !== null ? {busyAction} : {}),
    actionsDisabled: opkgBusy,
    compact: compactLayout,
  }))
);
const filtered = $derived.by(() =>
  rows.filter((p) => {
    if (
      filterMode === 'installed' && p.status === 'available'
    ) { return false; }
    if (filterMode === 'updates' && p.status !== 'update_available') {
      return false;
    }
    const query = filter.toLowerCase();
    return p.name.toLowerCase().includes(query)
      || p.description.toLowerCase().includes(query);
  })
);
const selectedCount = $derived(checked.size);
const updateCount = $derived(
  packages.filter((p) => p.status === 'update_available').length,
);
const selected = $derived([...checked]);
const selectedPackages = $derived(
  packages.filter((pkg) => checked.has(pkg.name)),
);
const selectedInstallCount = $derived(
  selectedPackages.filter((pkg) => pkg.status === 'available').length,
);
const selectedRemoveCount = $derived(
  selectedPackages.filter((pkg) =>
    pkg.status !== 'available' && !isProtectedPackage(pkg.name)
  ).length,
);
const selectedUpdateCount = $derived(
  selectedPackages.filter((pkg) =>
    pkg.status === 'update_available' && !isProtectedPackage(pkg.name)
  ).length,
);
const freshnessLabel = $derived.by(() => {
  if (metadataUpdatedAt === null) { return hostT('packages.never-refreshed'); }
  if (freshnessComputedAt === null) { return ''; }
  const ageMs = Math.max(
    0,
    freshnessComputedAt.getTime() - Date.parse(metadataUpdatedAt),
  );

  if (ageMs < 60_000) {
    return hostT('packages.just-now');
  }

  const relativeTime = new Intl.RelativeTimeFormat(appState.locale, {
    numeric: 'auto',
  });
  const ageMinutes = Math.floor(ageMs / 60_000);

  if (ageMinutes < 60) {
    return hostT('packages.refreshed-ago', {
      age: relativeTime.format(-ageMinutes, 'minute'),
    });
  }

  const ageHours = Math.floor(ageMs / 3_600_000);

  if (ageHours < 24) {
    return hostT('packages.refreshed-ago', {
      age: relativeTime.format(-ageHours, 'hour'),
    });
  }

  const ageDays = Math.floor(ageMs / 86_400_000);
  return hostT('packages.refreshed-ago', {
    age: relativeTime.format(-ageDays, 'day'),
  });
});
const freshnessStale = $derived.by(() => {
  if (metadataUpdatedAt === null || freshnessComputedAt === null) {
    return false;
  }
  return freshnessComputedAt.getTime() - Date.parse(metadataUpdatedAt)
    > 60 * 60 * 1000;
});
const freshnessWarning = $derived(metadataUpdatedAt === null || freshnessStale);

async function showAllPackages(): Promise<void> {
  if (filter !== '' || filterMode !== 'all') {
    filterVersion += 1;
  }
  filter = '';
  filterMode = 'all';
  await tick();
  searchInput?.focus();
}

function invalidateDetailCache(): void {
  detailGeneration += 1;
  detailCache.clear();
}

function loadDetail(name: string): void {
  if (detailCache.has(name)) {
    return;
  }

  const generation = detailGeneration;
  const promise = opkgClient.info(name);

  detailCache.set(name, {status: 'pending', promise});
  void promise.then((info) => {
    if (
      generation === detailGeneration
      && detailCache.get(name)?.status === 'pending'
    ) {
      detailCache.set(name, {status: 'success', info});
    }
  }).catch((reason: unknown) => {
    if (
      generation === detailGeneration
      && detailCache.get(name)?.status === 'pending'
    ) {
      detailCache.set(name, {
        status: 'failure',
        message: reason instanceof OpkgError
          ? reason.message
          : hostT('packages.detail-failed'),
      });
    }
  });
}

function retryDetail(name: string): void {
  if (detailCache.get(name)?.status !== 'failure') {
    return;
  }

  detailCache.delete(name);
  loadDetail(name);
}

async function fetchPackages(
  showLoading = packages.length === 0,
): Promise<void> {
  if (showLoading) {
    listLoading = true;
  }

  try {
    const result = await opkgClient.list();
    if (destroyed) {
      return;
    }
    packages = result.packages;
    metadataUpdatedAt = result.metadataUpdatedAt;
    freshnessComputedAt = now();
    invalidateDetailCache();
    loadError = false;
    loadErrorMessage = '';
    checked.clear();
    toast.dismissKey(PACKAGE_LIST_TOAST_KEY);
  } catch (error) {
    if (destroyed) {
      return;
    }
    loadError = true;
    loadErrorMessage = error instanceof OpkgError
      ? error.message
      : hostT('packages.load-failed');
  } finally {
    if (!destroyed) {
      listLoading = false;
    }
  }
}

async function runAction(
  action: 'install' | 'remove' | 'upgrade',
  pkgFilter: (p: PackageEntry) => boolean,
): Promise<void> {
  const names = Array.from(checked).filter((name) => {
    const pkg = packages.find((p) => p.name === name);
    return pkg !== undefined && pkgFilter(pkg);
  });
  if (names.length === 0) { return; }
  if (opkgBusy) { return; }
  if (action === 'remove') {
    const session = openHostModal<boolean, {
      message: string;
      confirmLabel: string;
      close: (result: boolean) => void;
    }>(hostServices.hostOverlay, ConfirmActionModal, {
      title: hostT('packages.confirm-remove-title'),
      props: {
        message: hostT('packages.confirm-remove', {names: names.join(', ')}),
        confirmLabel: hostT('packages.remove'),
      },
    });
    const event = await session.closed;
    if (destroyed) {
      return;
    }
    if (event.result) { await executeAction('remove', names, undefined, true); }
    return;
  }
  await executeAction(action, names, undefined, true);
}

async function executeAction(
  action: 'install' | 'remove' | 'upgrade',
  names: string[],
  focusTarget?: ActionFocusTarget,
  clearSelectionOnFinish = false,
): Promise<void> {
  if (names.length === 0 || opkgBusy) { return; }
  busyAction = action;
  busyNames.clear();
  for (const name of names) { busyNames.add(name); }
  const actionKey = action === 'install'
    ? 'packages.installing'
    : action === 'remove'
    ? 'packages.removing'
    : 'packages.updating';
  const toastKey = packageActionToastKey(action);
  try {
    let successMessage: string | undefined;
    try {
      const result = action === 'install'
        ? await opkgClient.install(names)
        : action === 'remove'
        ? await opkgClient.remove(names)
        : await opkgClient.upgrade(names);
      successMessage = result.message;
    } catch (error) {
      if (destroyed) {
        return;
      }
      toast.error(actionErrorMessage(error, actionKey), {key: toastKey});
    }
    if (destroyed) {
      return;
    }
    await fetchPackages(false);
    if (destroyed) {
      return;
    }
    if (successMessage !== undefined) {
      toast.success(successMessage, {key: toastKey});
    }
  } finally {
    if (clearSelectionOnFinish) {
      checked.clear();
    }
    if (!destroyed) {
      busyNames.clear();
      busyAction = null;
    }
    if (!destroyed && focusTarget !== undefined) {
      await restoreActionFocus(focusTarget);
    }
  }
}

async function restoreActionFocus(target: ActionFocusTarget): Promise<void> {
  await tick();
  if (destroyed) {
    return;
  }

  const table = tableElement as MndwTable<PackageEntry> | null;

  if (table !== null) {
    await table.updateComplete;
  }

  await tick();

  const packageActions = [
    ...document.querySelectorAll<HTMLElement & {disabled: boolean}>(
      'mndw-button[data-package][data-package-action]',
    ),
  ].filter((button) => {
    return button.dataset.package === target.packageName && !button.disabled;
  });
  const targetAction = packageActions.find((button) => {
    return button.dataset.packageAction === target.source;
  });
  const action = targetAction
    ?? packageActions[0]
    ?? document.querySelector<HTMLElement>(
      '.packages-panel .status-row mndw-button',
    );

  action?.focus();
}

function actionErrorMessage(error: unknown, actionKey: string): string {
  if (!(error instanceof OpkgError)) {
    return hostT('packages.action-failed', {action: hostT(actionKey)});
  }

  const conflict = dependencyConflictDetail(error);

  if (conflict === undefined) {
    return error.message;
  }

  if (conflict.dependents.length > 0) {
    return hostT(
      'packages.dependency-conflict',
      {
        package: conflict.package,
        dependents: conflict.dependents.join(', '),
      },
    );
  }

  return hostT(
    'packages.dependency-conflict-generic',
    {
      package: conflict.package,
    },
  );
}

async function handleRefresh(): Promise<void> {
  if (opkgBusy) { return; }
  checking = true;
  try {
    const result = await opkgClient.update();
    if (destroyed) {
      return;
    }
    await fetchPackages(false);
    if (destroyed) {
      return;
    }
    toast.success(result.message, {key: PACKAGE_REFRESH_TOAST_KEY});
  } catch (error) {
    if (destroyed) {
      return;
    }
    toast.error(
      error instanceof OpkgError ? error.message : hostT('app.error'),
      {key: PACKAGE_REFRESH_TOAST_KEY},
    );
  } finally {
    if (!destroyed) {
      checking = false;
    }
  }
}

function handleFilterChange(event: CustomEvent<{value: string}>): void {
  const value = event.detail.value;
  if (
    (value === 'all' || value === 'installed' || value === 'updates')
    && value !== filterMode
  ) {
    filterMode = value;
    filterVersion += 1;
  }
}

function handleSearchChange(event: CustomEvent<{value: string}>): void {
  if (filter !== event.detail.value) {
    filter = event.detail.value;
    filterVersion += 1;
  }
}

async function removeOne(
  name: string,
  source: ActionFocusTarget['source'] = 'primary',
): Promise<void> {
  const session = openHostModal<boolean,
    {message: string; confirmLabel: string; close: (result: boolean) => void}>(
      hostServices.hostOverlay,
      ConfirmActionModal,
      {
        title: hostT('packages.confirm-remove-title'),
        props: {message: hostT('packages.confirm-remove', {names: name}),
          confirmLabel: hostT('packages.remove')},
      },
    );
  const event = await session.closed;
  if (destroyed) {
    return;
  }
  if (event.result) {
    await executeAction('remove', [name], {packageName: name, source});
  }
}

const STATUS_ORDER: Record<PackageEntry['status'], number> = {
  installed: 0,
  update_available: 1,
  available: 2,
};
const nameRenderer = svelteCell<PackageCellRow, string>()(PackageNameCell);
const versionRenderer = svelteCell<PackageEntry, string>()(PackageVersionCell);
const statusRenderer = svelteCell<PackageEntry, PackageEntry['status']>()(
  PackageStatusCell,
);
const packageDetailCellRenderer = packageDetailRenderer({cache: detailCache,
  load: loadDetail, retry: retryDetail, onRemove: (name) =>
    removeOne(name, 'detail')});
const packageActionsCellRenderer = packageActionsRenderer(
  (action: PackageRowAction, name: string) => {
    if (opkgBusy) { return; }

    if (action === 'remove') {
      void removeOne(name);
      return;
    }

    void executeAction(action, [name], {packageName: name, source: 'primary'});
  },
  () => {
    void hostServices.router.current?.navigate(
      HOST_PATHS.settingsTab['self-update'],
    );
  },
);
const columns = $derived.by(() => [
  column<PackageCellRow>()({
    id: 'name',
    label: hostT('packages.package'),
    accessor: (row) => row.name,
    sortable: true,
    width: compactLayout ? '8rem' : '11.25rem',
    renderer: nameRenderer,
  }),
  column<PackageCellRow>()({
    id: 'version',
    label: hostT('packages.version'),
    accessor: (row) => row.version,
    sortable: true,
    comparator: compareVersions,
    renderer: versionRenderer,
  }),
  column<PackageCellRow>()({
    id: 'status',
    label: hostT('packages.status'),
    accessor: (row) => row.status,
    sortable: true,
    comparator: (a, b) => STATUS_ORDER[a] - STATUS_ORDER[b],
    renderer: statusRenderer,
  }),
  column<PackageCellRow>()({id: 'actions', label: '',
    ...(compactLayout ? {width: '6rem'} : {}),
    renderer: packageActionsCellRenderer}),
]);
const hiddenColumns = $derived(compactLayout ? ['version', 'status'] : []);
let expanded = new SvelteSet<string>();
let sortState = $state<SortState | null>(null);
const tableLabels = $derived.by(() => ({
  expandRow: (name: string) => hostT('packages.expand', {name}),
  collapseRow: (name: string) => hostT('packages.collapse', {name}),
}));

function handleSelectionChange(
  event: CustomEvent<MndwSelectionChangeDetail>,
): void {
  checked.clear();
  for (const key of event.detail.selected) { checked.add(key); }
}

function handleSortChange(event: CustomEvent<MndwSortChangeDetail>): void {
  sortState = event.detail.sort;
}

function handleRowExpand(event: CustomEvent<MndwRowExpandDetail>): void {
  expanded.clear();
  for (const key of event.detail.expanded) { expanded.add(key); }
}

$effect(() => {
  const visible = new Set(filtered.map((pkg) => pkg.name));

  untrack(() => {
    const drop = [...expanded].filter((key) => !visible.has(key));

    for (const key of drop) { expanded.delete(key); }
  });
});

$effect(() => {
  const currentFilterVersion = filterVersion;
  const firstKey = untrack(() => filtered[0]?.name);
  const table = tableElement as MndwTable<PackageEntry> | null;
  const sequence = ++filterSequence;

  if (firstKey === undefined || table === null) {
    return;
  }

  void (async () => {
    await table.updateComplete;

    if (
      sequence !== filterSequence
      || currentFilterVersion !== filterVersion
      || untrack(() => filtered[0]?.name) !== firstKey
    ) {
      return;
    }

    table.scrollToRow(firstKey, {align: 'start'});
  })();
});

onMount(() => {
  void fetchPackages();
  return observeCompactPanelWidth(panelElement, (compact) => {
    compactLayout = compact;
  });
});
</script>

<section
  bind:this={panelElement}
  class="packages-panel"
  data-locale={appState.locale}
>
  <div
    class={`status-row mndw-table-controls mndw-alert ${
      freshnessWarning ? 'mndw-alert--warning' : 'mndw-alert--info'
    }${compactLayout ? ' compact' : ''}`}
  >
    <span class="freshness">
      <mndw-icon
        name={freshnessWarning ? 'circle-alert' : 'info'}
        aria-hidden="true"
      ></mndw-icon>
      {freshnessLabel}
    </span>
    <mndw-button
      variant="secondary"
      disabled={opkgBusy}
      onclick={() => void handleRefresh()}
    >{hostT(checking ? 'packages.checking' : 'packages.refresh')}</mndw-button>
  </div>
  <div class="filter-row mndw-table-controls">
    <mndw-tabs
      value={filterMode}
      onmndwchange={handleFilterChange}
    >
      <mndw-tab id="all">{hostT('packages.all')}</mndw-tab>
      <mndw-tab id="installed">{hostT('packages.installed')}</mndw-tab>
      <mndw-tab id="updates">{
        hostT('packages.updates', {count: updateCount})
      }</mndw-tab>
    </mndw-tabs>
    <mndw-field
      class="search-field"
      label={hostT('packages.search-label')}
    >
      <mndw-input
        bind:this={searchInput}
        type="search"
        value={filter}
        aria-label={hostT('packages.search-label')}
        placeholder={hostT('packages.search')}
        onmndwinput={handleSearchChange}
      ></mndw-input>
    </mndw-field>
  </div>
  <div class="selection-row mndw-table-controls">
    {#if selectedCount === 0}
      <span class="selection-hint">{hostT('packages.selection-hint')}</span>
    {:else}
      <span class="selected-count">{
        hostT('packages.selection-count', {count: selectedCount})
      }</span>
      {#if selectedInstallCount > 0}
        <mndw-button
          variant="primary"
          disabled={opkgBusy}
          onclick={() =>
          void runAction('install', (pkg) => pkg.status === 'available')}
        >{
          hostT('packages.action-count', {
            action: hostT('packages.install'),
            count: selectedInstallCount,
          })
        }</mndw-button>
      {/if}
      {#if selectedUpdateCount > 0}
        <mndw-button
          variant="primary"
          disabled={opkgBusy}
          onclick={() =>
          void runAction('upgrade', (pkg) =>
            pkg.status === 'update_available'
            && !isProtectedPackage(pkg.name))}
        >{
          hostT('packages.action-count', {
            action: hostT('packages.update'),
            count: selectedUpdateCount,
          })
        }</mndw-button>
      {/if}
      {#if selectedRemoveCount > 0}
        <mndw-button
          variant="secondary"
          disabled={opkgBusy}
          onclick={() =>
          void runAction(
            'remove',
            (pkg) =>
              pkg.status !== 'available' && !isProtectedPackage(pkg.name),
          )}
        >{
          hostT('packages.action-count', {
            action: hostT('packages.remove'),
            count: selectedRemoveCount,
          })
        }</mndw-button>
      {/if}
      <mndw-button
        variant="secondary"
        disabled={opkgBusy}
        onclick={() => checked.clear()}
      >{hostT('packages.clear-selection')}</mndw-button>
    {/if}
  </div>
  <div class="table-wrap">
    {#if loadError}
      <div
        class="mndw-alert mndw-alert--danger package-load-error"
        role="alert"
      >
        <p>{loadErrorMessage}</p>
        <mndw-button
          variant="secondary"
          disabled={opkgBusy || listLoading}
          onclick={() => void fetchPackages()}
        >{hostT('common.retry')}</mndw-button>
      </div>
    {/if}
    {#if listLoading && packages.length === 0}
      <div
        class="msg-cell"
        role="status"
      >
        {hostT('packages.loading')}
      </div>
    {:else if !(loadError && packages.length === 0)}
      {#if filtered.length === 0}
        <EmptyState
          mode="compact"
          title={hostT(
            packages.length === 0 ? 'packages.empty' : 'packages.no-match',
          )}
          text={hostT(
            packages.length === 0
              ? 'packages.empty-next'
              : 'packages.no-match-next',
          )}
          action={packages.length === 0
          ? {label: hostT('packages.refresh'),
            onActivate: () => void fetchPackages(), variant: 'secondary'}
          : {label: hostT('packages.show-all'), onActivate: showAllPackages,
            variant: 'secondary'}}
        />
      {:else}
        <mndw-table
          bind:this={tableElement}
          columns={columns}
          rows={filtered}
          hiddenColumns={hiddenColumns}
          rowKey="name"
          virtual
          rowLabel={(row: PackageEntry) => row.name}
          selectable
          selected={selected}
          expandable
          toggleAfterColumn="name"
          expandOn="row"
          expanded={[...expanded]}
          expandedRenderer={packageDetailCellRenderer}
          columnMenu={false}
          sortMode="client"
          sort={sortState}
          labels={tableLabels}
          onmndwselectionchange={handleSelectionChange}
          onmndwsortchange={handleSortChange}
          onmndwrowexpand={handleRowExpand}
        ></mndw-table>
      {/if}
    {/if}
  </div>
</section>

<style>
.packages-panel { min-width: 0; padding: 1rem; font-family: var(--mndw-font-sans); color: var(--mndw-text); max-width: 75rem; }
.status-row, .filter-row, .selection-row { display: flex; align-items: center; gap: 0.5rem; }
.freshness { display: flex; align-items: center; gap: 0.5rem; min-width: 0; font-size: .75rem; }
.freshness mndw-icon { flex: 0 0 auto; font-size: .875rem; }
.status-row { box-sizing: border-box; width: 100%; min-width: 0; margin-bottom: 0.5rem; flex-wrap: wrap; }
.status-row > mndw-button { margin-left: auto; }
.status-row.compact > .freshness { flex-basis: 100%; }
.status-row.compact > mndw-button { margin-left: 0; }
.filter-row { min-width: 0; margin-bottom: 0.5rem; flex-wrap: wrap; }
.filter-row > mndw-tabs { flex: 0 0 auto; min-width: max-content; }
.search-field { flex: 1 1 14rem; min-width: min(100%, 14rem); max-width: 32rem; }
.selection-row { min-height: var(--mndw-control-h); margin-bottom: 0.5rem; flex-wrap: wrap; font-size: .8125rem; }
.selection-hint, .selected-count { color: var(--mndw-text-subtle); }
.table-wrap { min-width: 0; border: 1px solid var(--mndw-border); border-radius: 0.375rem; overflow: hidden; }
mndw-table { display: block; min-width: 0; font-size: .8125rem; }
mndw-table::part(viewport) { max-height: calc(100vh - 250px); overflow: auto; }
mndw-table::part(header-cell) { position: sticky; top: 0; z-index: 1; background: var(--mndw-surface); }
.msg-cell { text-align: center; padding: 2rem 0.625rem; color: var(--mndw-text-subtle); font-style: italic; }
.package-load-error { display: grid; justify-items: center; gap: 0.5rem; margin: 0.5rem; }
.package-load-error p { margin: 0; }
</style>
