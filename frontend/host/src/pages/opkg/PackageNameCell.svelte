<script lang="ts">
import {hostT} from '../../services/host-i18n.svelte.js';
import type {PackageCellRow} from './package-actions-renderer.svelte.js';

type Props = {row: PackageCellRow; value: string; colId: string};

let {row, value, colId}: Props = $props();

const statusLabel = $derived.by(() =>
  row.status === 'installed'
    ? hostT('packages.status-installed')
    : row.status === 'update_available'
    ? hostT('packages.update-available')
    : hostT('packages.available')
);
const compactMetaTitle = $derived(
  `${row.version}${
    row.newVersion === undefined ? '' : ` → ${row.newVersion}`
  } · ${statusLabel}`,
);
</script>

<span
  class="package-name"
  title={value}
>{value}</span>
{#if row.description !== ''}<span
    class="package-description"
    title={row.description}
  >{row.description}</span>{/if}
{#if row.compact}<span
    class="package-compact-meta"
    title={compactMetaTitle}
  ><span>{row.version}</span>{#if row.newVersion}<span
        class="version-change"
      >&nbsp;→ {row.newVersion}</span>{/if}<span aria-hidden="true"
    >&nbsp;·&nbsp;</span><span>{statusLabel}</span></span>{/if}

<style>
.package-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.package-description {
  display: block;
  overflow: hidden;
  color: var(--mndw-text-subtle);
  font-size: var(--mndw-text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.package-compact-meta {
  display: block;
  overflow: hidden;
  color: var(--mndw-text-subtle);
  font-size: var(--mndw-text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.package-compact-meta .version-change { color: var(--mndw-warning); }
</style>
