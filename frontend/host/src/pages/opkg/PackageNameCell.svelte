<script lang="ts">
import type {PackageEntry} from '../../services/opkg-client.js';

type Props = {row: PackageEntry; value: string; colId: string};

let {row, value, colId}: Props = $props();
</script>

<span
  class="package-name"
  title={value}
>{value}</span>

<style>
.package-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
</style>
