<script lang="ts">
import type {PackageEntry} from '../../services/opkg-client.js';

type Props = {row: PackageEntry; value: string; colId: string};

let {row, value, colId}: Props = $props();
</script>

<span
  class="ver-value"
  data-col={colId}
  title={value}
>{value}</span>{#if row.newVersion}<span class="new-version">&rarr; {
      row.newVersion
    }</span>{/if}

<style>
.ver-value { display: inline-block; max-width: 16ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.new-version { color: var(--mndw-warning); margin-left: 2px; }
</style>
