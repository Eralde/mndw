<script lang="ts">
import type {MndwSelectChangeDetail} from '@mndw/ui';
import {onMount} from 'svelte';
import {toggleTheme} from '../services/theme.service.js';
import {appState, resetToLogin, toggleSidebar} from '../state/app.svelte.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {getHostServices} from '../host-services-context.js';
import {mobileMediaQuery} from './breakpoint.js';
import {SIDEBAR_ID, SIDEBAR_TOGGLE_ID} from './ids.js';

const services = getHostServices();
const mobileQuery = mobileMediaQuery();
let isMobile = $state(mobileQuery.matches);

onMount(() => {
  const handleBreakpointChange = (event: MediaQueryListEvent): void => {
    isMobile = event.matches;
  };

  mobileQuery.addEventListener('change', handleBreakpointChange);

  return () => {
    mobileQuery.removeEventListener('change', handleBreakpointChange);
  };
});

function handleLocaleChange(event: CustomEvent<MndwSelectChangeDetail>): void {
  if (appState.localeSwitchPending) {
    return;
  }

  void services.locale.setLocale(event.detail.value).catch(() => {});
}

async function handleLogout(): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      services.rci.logout()
        .subscribe({
          next: () => resolve(),
          error: () => resolve(),
        });
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
      id={SIDEBAR_TOGGLE_ID}
      variant="ghost"
      class="mndw-header__menu-toggle"
      aria-label={hostT('nav.toggle-menu')}
      aria-expanded={isMobile ? appState.mobileSidebarOpen : !appState.desktopSidebarCollapsed}
      aria-controls={SIDEBAR_ID}
      onclick={toggleSidebar}
    >
      <mndw-icon name="menu"></mndw-icon>
    </mndw-button>
    <span class="mndw-header__brand">mndw</span>
    {#if appState.deviceInfo}
      <span class="mndw-header__device">{appState.deviceInfo.deviceName}</span>
    {/if}
  </div>
  <div class="mndw-header__right">
    <mndw-select
      class="mndw-header__locale-select"
      label={hostT('nav.language')}
      value={appState.locale}
      aria-busy={String(appState.localeSwitchPending)}
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
      <mndw-icon name={appState.theme === 'dark' ? 'sun' : 'moon'}></mndw-icon>
    </mndw-button>
    <mndw-button
      variant="ghost"
      class="mndw-header__logout"
      onclick={handleLogout}
    >
      <mndw-icon name="log-out"></mndw-icon>
      {hostT('nav.logout')}
    </mndw-button>
  </div>
</header>
