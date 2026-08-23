<script lang="ts">
import type {PackageEntry} from '../../services/opkg-client.js';
import {hostT} from '../../services/host-i18n.svelte.js';

type Props = {row: PackageEntry; value: PackageEntry['status']; colId: string};

let {row, value, colId}: Props = $props();

const label = $derived.by(() =>
  value === 'update_available'
    ? hostT('packages.update-available')
    : value === 'available'
    ? hostT('packages.available')
    : value
);
</script>

<span
  class="badge badge-{value}"
  data-col={colId}
>{label}</span>

<style>
.badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 0.625rem; font-size: .75rem; text-transform: capitalize; }
.badge-installed { color: var(--mndw-success); }
.badge-update_available { color: var(--mndw-warning); }
.badge-available { color: var(--mndw-text-subtle); }
</style>
