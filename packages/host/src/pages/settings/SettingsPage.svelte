<script lang="ts">
import PluginManager from './plugin-manager/PluginManager.svelte';
import PaletteManager from './palette-manager/PaletteManager.svelte';
import {toggleTheme} from '../../services/theme.service.js';
import {appState} from '../../state/app.svelte.js';
</script>

<div class="mndw-settings">
  <h2>Settings</h2>

  <section>
    <h3>Appearance</h3>
    <!-- A switch, not a checkbox: the theme applies at once rather than travelling with a form. -->
    <mndw-field label="Dark theme">
      <mndw-switch
        id="mndw-theme-switch"
        checked={appState.theme === 'dark'}
        onmndwchange={toggleTheme}
      ></mndw-switch>
    </mndw-field>
  </section>

  <PaletteManager />

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
.mndw-settings mndw-field {
  display: block;
  margin: 0.75rem 0;
}
</style>
