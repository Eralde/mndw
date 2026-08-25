<script lang="ts">
import {onMount} from 'svelte';
import {appState} from '../state/app.svelte.js';
import {mobileMediaQuery} from './breakpoint.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {getHostServices} from '../host-services-context.js';
import {appRouter} from '../router/create-app-router.js';

const registry = getHostServices().registry;
const mobileQuery = mobileMediaQuery();
let isMobile = $state(mobileQuery.matches);

const handleBreakpointChange = (event: MediaQueryListEvent): void => {
  isMobile = event.matches;
};

// The registry is populated before authenticated startup builds this shell, so a plain
// copy-and-sort (label, then name) matches the router/picker ordering without a store.
const pagePlugins = registry
  .getPages()
  .slice()
  .sort((a, b) =>
    a.entry.label.localeCompare(b.entry.label)
    || a.entry.name.localeCompare(b.entry.name)
  );

const currentPath = $derived.by(() => {
  return appRouter?.route.pathname ?? globalThis.location.pathname;
});

function normalizePath(pathname: string): string {
  const withoutTrailingSlash = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;

  return withoutTrailingSlash.toLowerCase();
}

function isActive(route: string): boolean {
  const current = normalizePath(currentPath);
  const target = normalizePath(route);

  return target === '/'
    ? current === '/'
    : current === target || current.startsWith(`${target}/`);
}

function closeOnMobile(): void {
  if (isMobile) {
    appState.mobileSidebarOpen = false;
  }
}

onMount(() => {
  mobileQuery.addEventListener('change', handleBreakpointChange);

  return () => mobileQuery.removeEventListener('change', handleBreakpointChange);
});
</script>

{#if isMobile && appState.mobileSidebarOpen}
  <div
    class="mndw-sidebar-backdrop"
    role="button"
    tabindex="0"
    aria-label={hostT('nav.close')}
    onclick={closeOnMobile}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        closeOnMobile();
      }
    }}
  >
  </div>
{/if}

<nav
  class="mndw-sidebar"
  data-locale={appState.locale}
  class:collapsed={!isMobile && appState.desktopSidebarCollapsed}
  class:mobile-collapsed={isMobile && !appState.mobileSidebarOpen}
>
  <a
    href="/"
    class="mndw-sidebar__link"
    class:active={isActive('/')}
    aria-current={isActive('/') ? 'page' : undefined}
    onclick={closeOnMobile}
  >
    {hostT('nav.dashboard')}
  </a>

  <a
    href="/packages"
    class="mndw-sidebar__link"
    class:active={isActive('/packages')}
    aria-current={isActive('/packages') ? 'page' : undefined}
    onclick={closeOnMobile}
  >
    {hostT('nav.package-manager')}
  </a>

  {#if pagePlugins.length > 0}
    <div class="mndw-sidebar__section-label">{hostT('nav.plugins')}</div>
    {#each pagePlugins as plugin (plugin.entry.name)}
      <a
        href={plugin.entry.route}
        class="mndw-sidebar__link"
        class:active={isActive(plugin.entry.route)}
        aria-current={isActive(plugin.entry.route) ? 'page' : undefined}
        onclick={closeOnMobile}
      >
        {plugin.entry.label}
      </a>
    {/each}
  {/if}

  <div class="mndw-sidebar__spacer"></div>
  <a
    href="/settings"
    class="mndw-sidebar__link"
    class:active={isActive('/settings')}
    aria-current={isActive('/settings') ? 'page' : undefined}
    onclick={closeOnMobile}
  >
    {hostT('nav.settings')}
  </a>
</nav>
