<script lang="ts">
import type {PackageEntry} from '../../services/opkg-client.js';
import {hostT} from '../../services/host-i18n.svelte.js';

type Props = {row: PackageEntry; onRemove: () => void};

let {row, onRemove}: Props = $props();
const isProtected = $derived(row.name === 'mndw' || row.name === 'lighttpd');
</script>

<mndw-button
  variant="danger"
  data-no-expand
  disabled={row.status === 'available' || isProtected}
  title={isProtected ? hostT('packages.protected') : undefined}
  onclick={() => onRemove()}
>{hostT('packages.remove')}</mndw-button>
