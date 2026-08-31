<script lang="ts">
import type {MndwTabsChangeDetail} from '@mndw/ui';
import {onMount} from 'svelte';
import DiagnosticsSettings from './DiagnosticsSettings.svelte';
import GeneralSettings from './GeneralSettings.svelte';
import PluginSettings from './PluginSettings.svelte';
import SelfUpdateSettings from './self-update/SelfUpdateSettings.svelte';
import {appRouter} from '../../router/create-app-router.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import {appState} from '../../state/app.svelte.js';
import {
  SETTINGS_DEFAULT_TAB,
  SETTINGS_TAB_DEFS,
  settingsPath,
  settingsTabFromPath,
} from './settings-route.js';

interface PermissionState {
  visible: boolean;
  available: boolean;
}

let permissionVisible = $state(false);
let permissionAvailable = $state(false);

const activeTab = $derived.by(() => {
  const pathname = appRouter?.route.pathname ?? globalThis.location.pathname;

  return settingsTabFromPath(pathname) ?? SETTINGS_DEFAULT_TAB;
});

onMount(() => {
  const router = appRouter;

  if (router?.route.pathname === '/settings') {
    void router.navigate(settingsPath(SETTINGS_DEFAULT_TAB), {replace: true});
  }
});

function handleTabChange(event: CustomEvent<MndwTabsChangeDetail>): void {
  const tab = SETTINGS_TAB_DEFS.find((candidate) => {
    return candidate.id === event.detail.value;
  });

  const router = appRouter;

  if (tab === undefined || router === undefined) {
    return;
  }

  void router.navigate(settingsPath(tab.id));
}

function handlePermissionStateChange(state: PermissionState): void {
  permissionVisible = state.visible;
  permissionAvailable = state.available;
}
</script>

<div
  class="mndw-settings"
  data-locale={appState.locale}
>
  <h2>{hostT('settings.title')}</h2>

  <mndw-tabs
    value={activeTab}
    onmndwchange={handleTabChange}
  >
    {#each SETTINGS_TAB_DEFS as tab (tab.id)}
      <mndw-tab
        id={tab.id}
        data-icon={tab.icon}
      >
        {hostT(tab.labelKey)}
      </mndw-tab>
    {/each}
    <mndw-tab-panel for="general">
      <GeneralSettings onPermissionStateChange={handlePermissionStateChange} />
    </mndw-tab-panel>
    <mndw-tab-panel for="diagnostics">
      <DiagnosticsSettings />
    </mndw-tab-panel>
    <mndw-tab-panel for="plugins">
      <PluginSettings
        {permissionVisible}
        {permissionAvailable}
      />
    </mndw-tab-panel>
    <mndw-tab-panel for="self-update">
      <SelfUpdateSettings />
    </mndw-tab-panel>
  </mndw-tabs>
</div>
