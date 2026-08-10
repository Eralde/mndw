<script lang="ts">
import type {MndwTabsChangeDetail} from '@mndw/ui';
import {onMount} from 'svelte';
import DiagnosticsSettings from './DiagnosticsSettings.svelte';
import GeneralSettings from './GeneralSettings.svelte';
import PluginSettings from './PluginSettings.svelte';
import {appRouter} from '../../router/create-app-router.js';
import {
  SETTINGS_DEFAULT_TAB,
  SETTINGS_TABS,
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
  const tab = SETTINGS_TABS.find((candidate) =>
    candidate === event.detail.value
  );
  const router = appRouter;

  if (tab === undefined || router === undefined) {
    return;
  }

  void router.navigate(settingsPath(tab));
}

function handlePermissionStateChange(state: PermissionState): void {
  permissionVisible = state.visible;
  permissionAvailable = state.available;
}
</script>

<div class="mndw-settings">
  <h2>Settings</h2>

  <mndw-tabs
    value={activeTab}
    onmndwchange={handleTabChange}
  >
    <mndw-tab id="general">General</mndw-tab>
    <mndw-tab id="diagnostics">Diagnostics</mndw-tab>
    <mndw-tab id="plugins">Plugins</mndw-tab>
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
  </mndw-tabs>
</div>
