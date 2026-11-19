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
import PackageNameCell from './PackageNameCell.svelte';
import PackageVersionCell from './PackageVersionCell.svelte';
import PackageStatusCell from './PackageStatusCell.svelte';
import {packageActionsRenderer} from './package-actions-renderer.svelte.js';
import type {PackageRowAction} from './package-actions-renderer.svelte.js';
import {packageDetailRenderer} from './package-detail-renderer.svelte.js';
import type {
  PackageDetailCache,
  PackageDetailState,
} from './PackageDetailCell.svelte';
import {compareVersions} from './compare-versions.js';
import ConfirmActionModal from './ConfirmActionModal.svelte';
import EmptyState from '../../components/EmptyState.svelte';

interface Props {
  now?: () => Date;
}

interface ActionFocusTarget {
  packageName: string;
  source: 'primary' | 'detail';
}

const PACKAGE_LIST_TOAST_KEY = 'packages.list';
const PACKAGE_REFRESH_TOAST_KEY = 'packages.refresh';

function packageActionToastKey(
  action: 'install' | 'remove' | 'upgrade',
): string {
  return `packages.${action}`;
}

let {now = () => new Date()}: Props = $props();
const hostServices = getHostServices();
const hostT = hostServices.locale.hostT;
const opkgClient = hostServices.opkgClient;
let packages = $state<PackageEntry[]>([]);
let metadataUpdatedAt = $state<string | null>(null);
let freshnessComputedAt = $state<Date | null>(null);
let checked = new SvelteSet<string>();
let filter = $state('');
let filterMode = $state<'all' | 'installed' | 'updates'>('installed');
let loading = $state(false);
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

const filtered = $derived.by(() =>
  packages.filter((p) => {
    if (
      filterMode === 'installed' && p.status === 'available'
    ) { return false; }
    if (filterMode === 'updates' && p.status !== 'update_available') {
      return false;
    }
    return p.name.toLowerCase().includes(filter.toLowerCase());
  })
);
const selectedCount = $derived(checked.size);
const updateCount = $derived(
  packages.filter((p) => p.status === 'update_available').length,
);
const selected = $derived([...checked]);
const canInstall = $derived(
  filtered.some((p) => checked.has(p.name) && p.status === 'available'),
);
const canRemove = $derived(
  filtered.some((p) =>
    checked.has(p.name) && p.status !== 'available' && !isProtected(p.name)
  ),
);
const canUpdate = $derived(
  filtered.some((p) => checked.has(p.name) && p.status === 'update_available'),
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

async function showAllPackages(): Promise<void> {
  filter = '';
  filterMode = 'all';
  await tick();
  searchInput?.focus();
}

function isProtected(name: string): boolean {
  return name === 'mndw' || name === 'lighttpd';
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

async function fetchPackages(suppressStatus = false): Promise<void> {
  loading = true;
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
    if (!suppressStatus) {
      toast.info(hostT('packages.loaded', {count: packages.length}), {
        key: PACKAGE_LIST_TOAST_KEY,
      });
    }
  } catch (error) {
    if (destroyed) {
      return;
    }
    packages = [];
    checked.clear();
    loadError = true;
    loadErrorMessage = error instanceof OpkgError
      ? error.message
      : hostT('packages.load-failed');
  } finally {
    if (!destroyed) {
      loading = false;
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
    if (event.result) { await executeAction('remove', names); }
    return;
  }
  await executeAction(action, names);
}

async function executeAction(
  action: 'install' | 'remove' | 'upgrade',
  names: string[],
  focusTarget?: ActionFocusTarget,
): Promise<void> {
  loading = true;
  const actionKey = action === 'install'
    ? 'packages.installing'
    : action === 'remove'
    ? 'packages.removing'
    : 'packages.updating';
  const toastKey = packageActionToastKey(action);
  try {
    const result = action === 'install'
      ? await opkgClient.install(names)
      : action === 'remove'
      ? await opkgClient.remove(names)
      : await opkgClient.upgrade(names);
    if (destroyed) {
      return;
    }
    await fetchPackages(true);
    if (destroyed) {
      return;
    }
    toast.success(result.message, {key: toastKey});
  } catch (error) {
    if (destroyed) {
      return;
    }
    toast.error(actionErrorMessage(error, actionKey), {key: toastKey});
  } finally {
    if (!destroyed) {
      loading = false;
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
      '.packages-panel .header-actions mndw-button',
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
  loading = true;
  try {
    const result = await opkgClient.update();
    if (destroyed) {
      return;
    }
    await fetchPackages(true);
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
      loading = false;
    }
  }
}

function handleFilterChange(event: CustomEvent<{value: string}>): void {
  const value = event.detail.value;
  if (
    value === 'all' || value === 'installed' || value === 'updates'
  ) { filterMode = value; }
}

function handleSearchChange(event: CustomEvent<{value: string}>): void {
  filter = event.detail.value;
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
const nameRenderer = svelteCell<PackageEntry, string>()(PackageNameCell);
const versionRenderer = svelteCell<PackageEntry, string>()(PackageVersionCell);
const statusRenderer = svelteCell<PackageEntry, PackageEntry['status']>()(
  PackageStatusCell,
);
const detailRenderer = packageDetailRenderer({cache: detailCache,
  load: loadDetail, retry: retryDetail, onRemove: (name) =>
    removeOne(name, 'detail')});
const actionsRenderer = packageActionsRenderer(
  (action: PackageRowAction, name: string) => {
    if (action === 'remove') {
      void removeOne(name);
      return;
    }

    void executeAction(action, [name], {packageName: name, source: 'primary'});
  },
);
const columns = $derived.by(() => [
  column<PackageEntry>()({
    id: 'name',
    label: hostT('packages.package'),
    accessor: (row) => row.name,
    sortable: true,
    width: '11.25rem',
    renderer: nameRenderer,
  }),
  column<PackageEntry>()({
    id: 'version',
    label: hostT('packages.version'),
    accessor: (row) => row.version,
    sortable: true,
    comparator: compareVersions,
    renderer: versionRenderer,
  }),
  column<PackageEntry>()({
    id: 'status',
    label: hostT('packages.status'),
    accessor: (row) => row.status,
    sortable: true,
    comparator: (a, b) => STATUS_ORDER[a] - STATUS_ORDER[b],
    renderer: statusRenderer,
  }),
  column<PackageEntry>()({id: 'actions', label: '', renderer: actionsRenderer}),
]);
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
  const firstKey = filtered[0]?.name;
  const table = tableElement as MndwTable<PackageEntry> | null;
  const sequence = ++filterSequence;

  if (firstKey === undefined || table === null) {
    return;
  }

  void (async () => {
    await table.updateComplete;

    if (sequence !== filterSequence || filtered[0]?.name !== firstKey) {
      return;
    }

    table.scrollToRow(firstKey, {align: 'start'});
  })();
});

onMount(() => {
  void fetchPackages();
});
</script>

<section
  class="packages-panel"
  data-locale={appState.locale}
>
  <div class="header-row mndw-table-controls">
    <div>
      <h1>{hostT('packages.title')}</h1>
      <span
        class:stale={freshnessStale}
        class="freshness"
      >{freshnessLabel}</span>
    </div>
    <div class="header-actions">
      <mndw-button
        variant="secondary"
        disabled={loading}
        onclick={() => void handleRefresh()}
      >{hostT('packages.refresh')}</mndw-button>
    </div>
  </div>
  <div class="filter-row mndw-table-controls">
    <mndw-field
      class="search-field"
      label={hostT('packages.search-label')}
    >
      <mndw-input
        bind:this={searchInput}
        type="search"
        value={filter}
        placeholder={hostT('packages.search')}
        onmndwinput={handleSearchChange}
      ></mndw-input>
    </mndw-field>
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
  </div>
  {#if selectedCount > 0}
    <div class="bulk-bar mndw-table-controls">
      <span class="bulk-label">{hostT('packages.with-selected')}</span>
      <mndw-button
        variant="primary"
        disabled={loading || !canInstall}
        onclick={() => void runAction('install', (p) => p.status === 'available')}
      >{hostT('packages.install')}</mndw-button>
      <mndw-button
        variant="secondary"
        disabled={loading || !canRemove}
        onclick={() =>
        void runAction('remove', (p) =>
          p.status !== 'available' && !isProtected(p.name))}
      >{hostT('packages.remove')}</mndw-button>
      <mndw-button
        variant="primary"
        disabled={loading || !canUpdate}
        onclick={() =>
        void runAction('upgrade', (p) => p.status === 'update_available')}
      >{hostT('packages.update')}</mndw-button>
      {#if selectedCount > 0}<span class="selected-count">{
          hostT('packages.selected', {count: selectedCount})
        }</span>{/if}
    </div>
  {/if}
  <div class="table-wrap">
    {#if loading}
      <div
        class="msg-cell"
        role="status"
      >
        {hostT('packages.loading')}
      </div>
    {:else if loadError}
      <div
        class="mndw-alert mndw-alert--danger package-load-error"
        role="alert"
      >
        <p>{loadErrorMessage}</p>
        <mndw-button
          variant="secondary"
          onclick={() => void fetchPackages()}
        >{hostT('common.retry')}</mndw-button>
      </div>
    {:else if filtered.length === 0}
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
        rowKey="name"
        virtual
        rowLabel={(row: PackageEntry) => row.name}
        selectable
        selected={selected}
        expandable
        toggleAfterColumn="name"
        expandOn="row"
        expanded={[...expanded]}
        expandedRenderer={detailRenderer}
        columnMenu={false}
        sortMode="client"
        sort={sortState}
        labels={tableLabels}
        onmndwselectionchange={handleSelectionChange}
        onmndwsortchange={handleSortChange}
        onmndwrowexpand={handleRowExpand}
      ></mndw-table>
    {/if}
  </div>
</section>

<style>
.packages-panel { min-width: 0; padding: 1rem; font-family: var(--mndw-font-sans); color: var(--mndw-text); max-width: 75rem; }
.header-row, .filter-row, .bulk-bar { display: flex; align-items: center; gap: 0.5rem; }
.header-row { justify-content: space-between; margin-bottom: 0.75rem; }
h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
.header-actions { display: flex; gap: 0.5rem; }
.freshness { color: var(--mndw-text-subtle); font-size: .75rem; }
.freshness.stale { color: var(--mndw-warning); }
.filter-row { min-width: 0; margin-bottom: 0.5rem; flex-wrap: wrap; }
.search-field { flex: 1; max-width: 20rem; }
.bulk-bar { margin-bottom: 0.5rem; font-size: .8125rem; }
.bulk-label, .selected-count { color: var(--mndw-text-subtle); }
.table-wrap { min-width: 0; border: 1px solid var(--mndw-border); border-radius: 0.375rem; overflow: hidden; }
mndw-table { display: block; min-width: 0; font-size: .8125rem; }
mndw-table::part(viewport) { max-height: calc(100vh - 250px); overflow: auto; }
mndw-table::part(header-cell) { position: sticky; top: 0; z-index: 1; background: var(--mndw-surface); }
.msg-cell { text-align: center; padding: 2rem 0.625rem; color: var(--mndw-text-subtle); font-style: italic; }
.package-load-error { display: grid; justify-items: center; gap: 0.5rem; }
.package-load-error p { margin: 0; }
</style>
