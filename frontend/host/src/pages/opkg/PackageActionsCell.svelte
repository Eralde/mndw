<script lang="ts">
import type {PackageEntry} from '../../services/opkg-client.js';
import type {PackageRowAction} from './package-actions-renderer.svelte.js';
import {hostT} from '../../services/host-i18n.svelte.js';

type Props = {row: PackageEntry; onAction: (action: PackageRowAction) => void};

let {row, onAction}: Props = $props();
const isProtected = $derived(row.name === 'mndw' || row.name === 'lighttpd');
const action = $derived.by((): PackageRowAction => {
  if (row.status === 'available') {
    return 'install';
  }
  if (row.status === 'update_available') {
    return 'upgrade';
  }
  return 'remove';
});
const label = $derived(
  action === 'install'
    ? hostT('packages.install')
    : action === 'upgrade'
    ? hostT('packages.update')
    : hostT('packages.remove'),
);
</script>

<mndw-button
  variant={action === 'remove' ? 'secondary' : 'primary'}
  data-package={row.name}
  data-package-action="primary"
  data-no-expand
  disabled={action === 'remove' && isProtected}
  title={isProtected ? hostT('packages.protected') : undefined}
  onclick={() => onAction(action)}
>{label}</mndw-button>
