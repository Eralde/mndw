<script lang="ts">
import {rciService} from '../services/rci.service.js';
import {toggleTheme} from '../services/theme.service.js';
import {appState, resetToLogin} from '../state/app.svelte.js';

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
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      variant="ghost"
      class="mndw-header__menu-toggle"
      aria-label="Toggle menu"
      onclick={() => appState.sidebarCollapsed = !appState.sidebarCollapsed}
    >
      ☰
    </mndw-button>
    <span class="mndw-header__brand">mndw</span>
    {#if appState.hostInfo}
      <span class="mndw-header__device">{appState.hostInfo.deviceName}</span>
    {/if}
  </div>
  <div class="mndw-header__right">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      variant="ghost"
      class="mndw-header__theme-toggle"
      title={appState.theme === 'dark'
      ? 'Switch to light theme'
      : 'Switch to dark theme'}
      aria-label="Toggle color theme"
      onclick={toggleTheme}
    >
      {appState.theme === 'dark' ? '☀' : '☾'}
    </mndw-button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      variant="danger"
      class="mndw-header__logout"
      onclick={handleLogout}
    >
      Logout
    </mndw-button>
  </div>
</header>
