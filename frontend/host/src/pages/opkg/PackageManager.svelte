<script lang="ts">
import type {MndwTabsChangeDetail} from '@mndw/ui';
import {getHostServices} from '../../host-services-context.js';
import {appState} from '../../state/app.svelte.js';
import PackagesPanel from './PackagesPanel.svelte';
import ServicesPanel from './ServicesPanel.svelte';
import {PACKAGE_MANAGER_TAB_DEFS} from './package-manager-tabs.js';
import {
  packageManagerPath,
  packageManagerTabFromPath,
} from './package-manager-route.js';

const services = getHostServices();
const hostT = services.locale.hostT;

const activeTab = $derived.by(() => {
  const pathname = services.router.current?.route.pathname
    ?? globalThis.location.pathname;
  return packageManagerTabFromPath(pathname) ?? 'packages';
});

function handleTabChange(event: CustomEvent<MndwTabsChangeDetail>): void {
  const tab = PACKAGE_MANAGER_TAB_DEFS.find((candidate) =>
    candidate.id === event.detail.value
  );
  const router = services.router.current;

  if (tab !== undefined && router !== undefined) {
    void router.navigate(packageManagerPath(tab.id));
  }
}
</script>

<div
  class="package-manager"
  data-locale={appState.locale}
>
  <mndw-tabs
    class="mndw-table-controls"
    value={activeTab}
    onmndwchange={handleTabChange}
  >
    {#each PACKAGE_MANAGER_TAB_DEFS as tab (tab.id)}
      <mndw-tab id={tab.id}>{hostT(tab.labelKey)}</mndw-tab>
    {/each}
    <mndw-tab-panel
      for="packages"
    >{#if activeTab === 'packages'}<PackagesPanel />{/if}</mndw-tab-panel>
    <mndw-tab-panel
      for="services"
    >{#if activeTab === 'services'}<ServicesPanel />{/if}</mndw-tab-panel>
  </mndw-tabs>
</div>

<style>
.package-manager { min-width: 0; color: var(--mndw-text); }
</style>
