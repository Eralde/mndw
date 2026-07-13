<script lang="ts">
import PluginManager from './plugin-manager/PluginManager.svelte';
import {toggleTheme} from '../../services/theme.service.js';
import {appState} from '../../state/app.svelte.js';

// Phase 3 settings: appearance + device info. Plugin management (installed list,
// upload, pending approvals) and dashboard settings land in later phases.
</script>

<div class="mndw-settings">
  <h2>Settings</h2>

  <section>
    <h3>Appearance</h3>
    <label class="mndw-settings__toggle">
      <input
        type="checkbox"
        checked={appState.theme === 'dark'}
        onchange={toggleTheme}
      />
      Dark theme
    </label>
  </section>

  <section>
    <h3>Device</h3>
    {#if appState.hostInfo}
      <ul>
        <li><strong>Name:</strong> {appState.hostInfo.deviceName}</li>
        <li><strong>Vendor:</strong> {appState.hostInfo.vendor}</li>
        <li><strong>Firmware:</strong> {appState.hostInfo.firmwareVersion}</li>
      </ul>
    {:else}
      <p>Device info unavailable.</p>
    {/if}
  </section>

  <section>
    <PluginManager />
  </section>
</div>

<style>
.mndw-settings__toggle {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin: 0.75rem 0;
}
</style>
