<script lang="ts">
import type {MndwCheckboxChangeDetail, MndwTabsChangeDetail} from '@mndw/ui';
import {onMount} from 'svelte';
import {SvelteSet} from 'svelte/reactivity';
import {OpkgError, opkgClient} from '../../services/opkg-client.js';
import type {PackageEntry} from '../../services/opkg-client.js';

let packages = $state<PackageEntry[]>([]);
let checked = new SvelteSet<string>();
let filter = $state('');
let filterMode = $state<'all' | 'installed' | 'updates'>('all');
let statusMsg = $state('');
let statusVariant = $state<'success' | 'error' | 'info'>('info');
let loading = $state(false);
let loadError = $state(false);

const filtered = $derived.by(() => {
  return packages.filter((p) => {
    if (filterMode === 'installed' && p.status === 'uninstalled') {
      return false;
    }
    if (filterMode === 'updates' && p.status !== 'update_available') {
      return false;
    }
    return p.name.toLowerCase().includes(filter.toLowerCase());
  });
});
const selectedCount = $derived(checked.size);
const updateCount = $derived.by(() => {
  return packages.filter((p) => p.status === 'update_available').length;
});
const allFilteredChecked = $derived.by(() => {
  return filtered.length > 0 && filtered.every((p) => checked.has(p.name));
});
const someFilteredChecked = $derived(filtered.some((p) => checked.has(p.name)));
const canInstall = $derived.by(() => {
  return filtered.some((p) =>
    checked.has(p.name) && p.status === 'uninstalled'
  );
});
const canRemove = $derived.by(() => {
  return filtered.some((p) =>
    checked.has(p.name) && p.status !== 'uninstalled'
  );
});
const canUpdate = $derived.by(() => {
  return filtered.some((p) =>
    checked.has(p.name) && p.status === 'update_available'
  );
});

const setStatus = (
  msg: string,
  variant: 'success' | 'error' | 'info',
): void => {
  statusMsg = msg;
  statusVariant = variant;
};

// The class layer names the severity `danger`; this component's callers say `error`.
const statusSeverity = $derived.by(() => {
  return statusVariant === 'error' ? 'danger' : statusVariant;
});

const fetchPackages = async (suppressStatus = false): Promise<void> => {
  loading = true;
  try {
    packages = await opkgClient.list();
    loadError = false;
    checked.clear();
    if (!suppressStatus) {
      setStatus(`${packages.length} packages loaded`, 'info');
    }
  } catch (error) {
    packages = [];
    checked.clear();
    loadError = true;
    setStatus(
      error instanceof OpkgError ? error.message : 'Failed to load packages',
      'error',
    );
  } finally {
    loading = false;
  }
};

const runAction = async (
  action: 'install' | 'remove' | 'upgrade',
  label: string,
  pkgFilter: (p: PackageEntry) => boolean,
): Promise<void> => {
  const names = Array.from(checked).filter((name) => {
    const pkg = packages.find((p) => p.name === name);
    return pkg !== undefined && pkgFilter(pkg);
  });
  if (names.length === 0) {
    return;
  }

  loading = true;
  setStatus(`${label}ing...`, 'info');
  try {
    const result = action === 'install'
      ? await opkgClient.install(names)
      : action === 'remove'
      ? await opkgClient.remove(names)
      : await opkgClient.upgrade(names);
    await fetchPackages(true);
    setStatus(result.message, 'success');
  } catch (error) {
    setStatus(
      error instanceof OpkgError ? error.message : `${label} failed`,
      'error',
    );
  } finally {
    loading = false;
  }
};

const handleRefresh = async (): Promise<void> => {
  loading = true;
  setStatus('Refreshing metadata...', 'info');
  try {
    const result = await opkgClient.update();
    await fetchPackages(true);
    setStatus(result.message, 'success');
  } catch (error) {
    setStatus(
      error instanceof OpkgError ? error.message : 'Refresh failed',
      'error',
    );
  } finally {
    loading = false;
  }
};

const handleSelectAllChange = (
  event: CustomEvent<MndwCheckboxChangeDetail>,
): void => {
  if (!event.detail.checked) {
    for (const p of filtered) {
      checked.delete(p.name);
    }
  } else {
    for (const p of filtered) {
      checked.add(p.name);
    }
  }
};

const handlePackageChange = (
  name: string,
  event: CustomEvent<MndwCheckboxChangeDetail>,
): void => {
  if (event.detail.checked) {
    checked.add(name);
  } else {
    checked.delete(name);
  }
};

const handleFilterChange = (event: CustomEvent<MndwTabsChangeDetail>): void => {
  const value = event.detail.value;

  if (value === 'all' || value === 'installed' || value === 'updates') {
    filterMode = value;
  }
};

onMount(() => {
  void fetchPackages();
});
</script>

<div class="opkg-manager">
  <div class="header-row">
    <h1>Package Manager</h1>
    <div class="header-actions">
      <mndw-button
        variant="secondary"
        disabled={loading}
        onclick={() => void handleRefresh()}
      >
        Refresh Metadata
      </mndw-button>
      <mndw-button
        variant="secondary"
        disabled={loading}
        onclick={() => void fetchPackages()}
      >
        Reload
      </mndw-button>
    </div>
  </div>

  <div class="filter-row">
    <input
      type="search"
      bind:value={filter}
      placeholder="Search packages..."
      class="filter-input"
    />
    <mndw-tabs
      value={filterMode}
      onmndwchange={handleFilterChange}
    >
      <mndw-tab id="all">All</mndw-tab>
      <mndw-tab id="installed">Installed</mndw-tab>
      <mndw-tab id="updates">Updates ({updateCount})</mndw-tab>
    </mndw-tabs>
  </div>

  <div class="bulk-bar">
    <span class="bulk-label">With selected:</span>
    <mndw-button
      variant="primary"
      disabled={loading || !canInstall}
      onclick={() =>
      void runAction('install', 'Install', (p) =>
        p.status === 'uninstalled')}
    >
      Install
    </mndw-button>
    <mndw-button
      variant="danger"
      disabled={loading || !canRemove}
      onclick={() =>
      void runAction('remove', 'Remove', (p) =>
        p.status !== 'uninstalled')}
    >
      Remove
    </mndw-button>
    <mndw-button
      variant="primary"
      disabled={loading || !canUpdate}
      onclick={() =>
      void runAction('upgrade', 'Upgrade', (p) =>
        p.status === 'update_available')}
    >
      Update
    </mndw-button>
    {#if selectedCount > 0}
      <span class="selected-count">({selectedCount} selected)</span>
    {/if}
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="col-check">
            <mndw-checkbox
              checked={allFilteredChecked}
              indeterminate={someFilteredChecked && !allFilteredChecked}
              aria-label="Select all filtered packages"
              onmndwchange={handleSelectAllChange}
            ></mndw-checkbox>
          </th>
          <th class="col-name">Package</th>
          <th class="col-ver">Version</th>
          <th class="col-status">Status</th>
          <th class="col-desc">Description</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          <tr>
            <td
              colspan="5"
              class="msg-cell"
            >
              Loading...
            </td>
          </tr>
        {:else if loadError}
          <tr>
            <td
              colspan="5"
              class="msg-cell"
            >
              Failed to load packages
            </td>
          </tr>
        {:else if packages.length === 0}
          <tr>
            <td
              colspan="5"
              class="msg-cell"
            >
              No packages found
            </td>
          </tr>
        {:else if filtered.length === 0}
          <tr>
            <td
              colspan="5"
              class="msg-cell"
            >
              No packages match your filter
            </td>
          </tr>
        {:else}
          {#each filtered as pkg (pkg.name)}
            <tr>
              <td class="col-check">
                <mndw-checkbox
                  checked={checked.has(pkg.name)}
                  aria-label={`Select ${pkg.name}`}
                  onmndwchange={(event: CustomEvent<MndwCheckboxChangeDetail>) =>
                  handlePackageChange(pkg.name, event)}
                ></mndw-checkbox>
              </td>
              <td
                class="col-name"
                title={pkg.name}
              >
                {pkg.name}
              </td>
              <td class="col-ver">
                {pkg.version}
                {#if pkg.newVersion}
                  <span class="new-version">&rarr; {pkg.newVersion}</span>
                {/if}
              </td>
              <td class="col-status">
                <span class="badge badge-{pkg.status}">
                  {
                    pkg.status === 'update_available'
                    ? 'update available'
                    : pkg.status
                  }
                </span>
              </td>
              <td class="col-desc">{pkg.description}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if statusMsg}
    <div
      class="status-bar mndw-alert mndw-alert--{statusSeverity}"
      role="status"
      aria-live="polite"
    >
      {statusMsg}
    </div>
  {/if}
</div>

<style>
.opkg-manager {
  padding: 16px;
  font-family: var(--mndw-font-sans);
  color: var(--mndw-text);
  max-width: 1200px;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.header-row h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.header-actions mndw-button,
.bulk-bar mndw-button {
  display: inline-block;
}

:global(.header-actions mndw-button)::part(button),
:global(.bulk-bar mndw-button)::part(button) {
  padding: 6px 12px;
  font-size: 0.8125rem;
  white-space: nowrap;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.filter-input {
  flex: 1;
  max-width: 320px;
  padding: 6px 10px;
  font-size: 0.8125rem;
  border: 1px solid var(--mndw-border);
  border-radius: 4px;
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
  box-sizing: border-box;
}

.filter-input::placeholder {
  color: var(--mndw-text-subtle);
}

.filter-row mndw-tabs {
  display: block;
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 0.8125rem;
}

.bulk-label {
  color: var(--mndw-text-subtle);
}

.selected-count {
  color: var(--mndw-text-subtle);
  font-size: 0.75rem;
}

.table-wrap {
  overflow: auto;
  border: 1px solid var(--mndw-border);
  border-radius: 6px;
  max-height: calc(100vh - 250px);
}

table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 8px 10px;
  font-weight: 600;
  background: var(--mndw-surface);
  border-bottom: 1px solid var(--mndw-border);
  white-space: nowrap;
  color: var(--mndw-text-muted);
}

td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--mndw-border);
  vertical-align: middle;
}

tr:last-child td {
  border-bottom: none;
}

.col-check {
  width: 32px;
  text-align: center;
}

.col-name {
  width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.col-ver {
  width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-status {
  width: 120px;
  white-space: nowrap;
}

.col-desc {
  color: var(--mndw-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

td.col-check mndw-checkbox {
  vertical-align: middle;
}

.msg-cell {
  text-align: center;
  padding: 32px 10px;
  color: var(--mndw-text-subtle);
  font-style: italic;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: capitalize;
}

.badge-installed {
  background: color-mix(in srgb, var(--mndw-success) 15%, transparent);
  color: var(--mndw-success);
}

.badge-update_available {
  background: color-mix(in srgb, var(--mndw-warning) 15%, transparent);
  color: var(--mndw-warning);
}

.badge-uninstalled {
  background: var(--mndw-surface-raised);
  color: var(--mndw-text-subtle);
}

.new-version {
  color: var(--mndw-warning);
  font-size: 0.75rem;
  margin-left: 2px;
}

/* Spacing only. `.mndw-alert` and its severity modifier own the box and the colours. */
.status-bar {
  margin-top: 8px;
  font-size: 0.8125rem;
}
</style>
