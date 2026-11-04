<script lang="ts">
import type {
  HostLock,
  InstallVersionWarning,
} from '../../../runtime/plugin-lock.js';
import {getInstallVersionWarnings} from '../../../runtime/plugin-lock.js';
import {hostT} from '../../../services/host-i18n.svelte.js';

interface Props {
  lock?: HostLock;
}

let {lock}: Props = $props();
let warnings = $derived(
  lock === undefined ? [] : getInstallVersionWarnings(lock),
);

function warningText(warning: InstallVersionWarning): string {
  if (warning.kind === 'sdk-major') {
    return hostT('settings.plugin-manager.version-warning.sdk-major', {
      pluginVersion: warning.pluginVersion,
      hostVersion: warning.hostVersion,
    });
  }

  if (warning.kind === 'sdk-newer-minor') {
    return hostT('settings.plugin-manager.version-warning.sdk-newer-minor', {
      pluginVersion: warning.pluginVersion,
      hostVersion: warning.hostVersion,
    });
  }

  return hostT('settings.plugin-manager.version-warning.shared-major', {
    name: warning.name,
    pluginVersion: warning.pluginVersion,
    hostVersion: warning.hostVersion,
  });
}
</script>

{#if warnings.length > 0}
  <section
    class="mndw-version-warning"
    role="note"
  >
    <h4>{hostT('settings.plugin-manager.version-warning.title')}</h4>
    <ul>
      {#each warnings as warning (`${warning.kind}:${warning.name}`)}
        <li>{warningText(warning)}</li>
      {/each}
    </ul>
    <p>{hostT('settings.plugin-manager.version-warning.install-anyway')}</p>
  </section>
{/if}

<style>
.mndw-version-warning {
  display: grid;
  gap: var(--mndw-space-1);
  padding: var(--mndw-space-2);
  border: 1px solid var(--mndw-warning);
  border-radius: var(--mndw-radius-sm);
  background: var(--mndw-surface-raised);
}

.mndw-version-warning h4,
.mndw-version-warning p {
  margin: 0;
}

.mndw-version-warning h4 {
  font-size: var(--mndw-text-sm);
  font-weight: var(--mndw-weight-semibold);
}

.mndw-version-warning ul {
  display: grid;
  gap: var(--mndw-space-1);
  margin: 0;
  padding-inline-start: var(--mndw-space-4);
  font-size: var(--mndw-text-sm);
}

.mndw-version-warning p {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
}
</style>
