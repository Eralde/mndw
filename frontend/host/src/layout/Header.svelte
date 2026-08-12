<script lang="ts">
import type {MndwSelectChangeDetail} from '@mndw/ui';
import {rciService} from '../services/rci.service.js';
import {extenderAccessService} from '../services/extender-access.service.js';
import {toggleTheme} from '../services/theme.service.js';
import {appState, resetToLogin} from '../state/app.svelte.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {setLocale} from '../services/locale.service.js';

function handleLocaleChange(event: CustomEvent<MndwSelectChangeDetail>): void {
  void setLocale(event.detail.value).catch(() => {});
}

async function handleLogout(): Promise<void> {
  try {
    await extenderAccessService.postForget();
  } catch {
    // Router logout and local reset must proceed even when mwsd is unavailable.
  }
  try {
    await new Promise<void>((resolve) => {
      rciService.logout().subscribe({next: () => resolve(), error: () =>
        resolve()});
    });
  } finally {
    resetToLogin();
  }
}
</script>

<header
  class="mndw-header"
  data-locale={appState.locale}
>
  <div class="mndw-header__left">
    <mndw-button
      variant="ghost"
      class="mndw-header__menu-toggle"
      aria-label={hostT('nav.toggle-menu')}
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
    <mndw-select
      class="mndw-header__locale-select"
      label={hostT('nav.language')}
      value={appState.locale}
      disabled={appState.localeSwitchPending}
      onmndwchange={handleLocaleChange}
    >
      <mndw-option value="en">EN</mndw-option>
      <mndw-option value="ru">RU</mndw-option>
    </mndw-select>
    <mndw-button
      variant="ghost"
      class="mndw-header__theme-toggle"
      title={appState.theme === 'dark'
      ? hostT('nav.light-theme')
      : hostT('nav.dark-theme')}
      aria-label={hostT('nav.color-theme')}
      onclick={toggleTheme}
    >
      {appState.theme === 'dark' ? '☀' : '☾'}
    </mndw-button>
    <mndw-button
      variant="danger"
      class="mndw-header__logout"
      onclick={handleLogout}
    >
      {hostT('nav.logout')}
    </mndw-button>
  </div>
</header>
