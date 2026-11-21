<script lang="ts">
import type {
  PackageCellRow,
  PackageRowAction,
} from './package-actions-renderer.svelte.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {HOST_PATHS} from '../../router/host-routes.js';
import {isProtectedPackage} from './package-protection.js';

type Props = {
  row: PackageCellRow;
  onAction: (action: PackageRowAction) => void;
  onUpdateInSettings: () => void;
};

let {row, onAction, onUpdateInSettings}: Props = $props();
const isProtected = $derived(isProtectedPackage(row.name));
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
const progressLabel = $derived.by(() => {
  if (row.busyAction === 'install') {
    return hostT('packages.installing');
  }
  if (row.busyAction === 'remove') {
    return hostT('packages.removing');
  }
  if (row.busyAction === 'upgrade') {
    return hostT('packages.updating');
  }

  return undefined;
});
</script>

{#if progressLabel !== undefined}<span
    class="action-label"
    class:compact-action={row.compact}
    role="status"
  >{progressLabel}</span>
{:else if action === 'remove' && isProtected}<span
    class="action-label protected-label"
    class:compact-action={row.compact}
    title={hostT('packages.protected')}
  ><span aria-hidden="true">{hostT('packages.protected-label')}</span><span
      class="mndw-visually-hidden"
    >{hostT('packages.protected')}</span></span>
{:else if action === 'upgrade' && isProtected}<a
    class="settings-update-link mndw-link"
    class:compact-action={row.compact}
    href={HOST_PATHS.settingsTab['self-update']}
    onclick={(event) => {
      event.preventDefault();
      onUpdateInSettings();
    }}
  >{hostT('packages.update-in-settings')}</a>
{:else}<mndw-button
    class:compact-action={row.compact}
    variant={action === 'remove' ? 'secondary' : 'primary'}
    disabled={row.actionsDisabled === true}
    data-package={row.name}
    data-package-action="primary"
    data-no-expand
    onclick={() => onAction(action)}
  >{label}</mndw-button>{/if}

<style>
.action-label {
  display: inline-flex;
  min-height: var(--mndw-control-h);
  align-items: center;
  padding-inline: var(--mndw-space-3);
  color: var(--mndw-text-subtle);
  font-size: var(--mndw-text-xs);
}
mndw-button.compact-action { max-width: 100%; }
.settings-update-link { display: inline-flex; min-height: var(--mndw-control-h); align-items: center; padding-inline: var(--mndw-space-3); font-size: var(--mndw-text-xs); }
.settings-update-link.compact-action { max-width: 100%; box-sizing: border-box; overflow: hidden; padding-inline: var(--mndw-space-2); text-overflow: ellipsis; white-space: nowrap; }
.action-label.compact-action {
  max-width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  padding-inline: var(--mndw-space-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
