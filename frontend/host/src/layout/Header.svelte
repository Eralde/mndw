<script lang="ts">
import {rciService} from '../services/rci.service.js';
import {extenderAccessService} from '../services/extender-access.service.js';
import {toggleTheme} from '../services/theme.service.js';
import {appState, resetToLogin} from '../state/app.svelte.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {setLocale} from '../services/locale.service.js';

function switchLocale(locale: string): void {
  void setLocale(locale).catch(() => {});
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
    <div
      class="mndw-header__locale-toggle"
      role="group"
      aria-label={hostT('nav.language')}
    >
      <mndw-button
        variant={appState.locale === 'en' ? 'primary' : 'ghost'}
        class="mndw-header__locale-button"
        aria-label={hostT('nav.language-english')}
        aria-pressed={appState.locale === 'en'}
        title={hostT('nav.language-english')}
        disabled={appState.localeSwitchPending}
        onclick={() => switchLocale('en')}
      >
        EN
      </mndw-button>
      <mndw-button
        variant={appState.locale === 'ru' ? 'primary' : 'ghost'}
        class="mndw-header__locale-button"
        aria-label={hostT('nav.language-russian')}
        aria-pressed={appState.locale === 'ru'}
        title={hostT('nav.language-russian')}
        disabled={appState.localeSwitchPending}
        onclick={() => switchLocale('ru')}
      >
        RU
      </mndw-button>
    </div>
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
