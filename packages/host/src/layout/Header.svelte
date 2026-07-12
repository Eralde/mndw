<script lang="ts">
import {rciService} from '../services/rci.service.js';
import {toggleTheme} from '../services/theme.service.js';
import {appState} from '../state/app.svelte.js';

function resetToLogin(): void {
  appState.authenticated = false;
  appState.ready = false;
  appState.hostInfo = null;
}

function handleLogout(): void {
  // Reset to the login screen regardless of whether the device ack's the logout.
  rciService.logout().subscribe({
    next: resetToLogin,
    error: resetToLogin,
  });
}
</script>

<header class="mndw-header">
  <div class="mndw-header__left">
    <button
      class="mndw-header__menu-toggle"
      onclick={() => appState.sidebarCollapsed = !appState.sidebarCollapsed}
    >
      ☰
    </button>
    <span class="mndw-header__brand">mndw</span>
    {#if appState.hostInfo}
      <span class="mndw-header__device">{appState.hostInfo.deviceName}</span>
    {/if}
  </div>
  <div class="mndw-header__right">
    <button
      class="mndw-header__theme-toggle"
      title={appState.theme === 'dark'
      ? 'Switch to light theme'
      : 'Switch to dark theme'}
      aria-label="Toggle color theme"
      onclick={toggleTheme}
    >
      {appState.theme === 'dark' ? '☀' : '☾'}
    </button>
    <button
      class="mndw-header__logout"
      onclick={handleLogout}
    >
      Logout
    </button>
  </div>
</header>
