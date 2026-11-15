<script lang="ts">
import {focusTrap} from '../components/focus-trap/focus-trap-action.js';
import {onMount, untrack} from 'svelte';
import {appState} from '../state/app.svelte.js';
import {mobileMediaQuery} from './breakpoint.js';
import {SIDEBAR_ID, SIDEBAR_TOGGLE_ID} from './ids.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {getHostServices} from '../host-services-context.js';
import {appRouter} from '../router/create-app-router.js';
import {HOST_PATHS} from '../router/host-routes.js';
import {getPagePluginCandidates} from '../runtime/page-plugin-candidates.js';

const registry = getHostServices().registry;
const mobileQuery = mobileMediaQuery();

let isMobile = $state(mobileQuery.matches);
let sidebarElement: HTMLElement | undefined;

// The nav is inert whenever the current mode hides it: mobile drawer closed, or desktop
// collapsed. Tracked as a derived value so the focus rescue below also covers mode flips
// (e.g. resizing to mobile with focus inside the still-expanded sidebar).
const navInert = $derived(
  isMobile ? !appState.mobileSidebarOpen : appState.desktopSidebarCollapsed,
);
// Untracked: only the value at instantiation matters, later changes are picked up by $effect.
let previousNavInert = untrack(() =>
  isMobile ? !appState.mobileSidebarOpen : appState.desktopSidebarCollapsed
);

const handleBreakpointChange = (event: MediaQueryListEvent): void => {
  isMobile = event.matches;
};

const pagePlugins = $derived.by(() => {
  return getPagePluginCandidates(registry).map((page) => ({
    ...page,
    failed: page.status !== 'loaded',
  }));
});

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

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isMobile && appState.mobileSidebarOpen) {
    appState.mobileSidebarOpen = false;
  }
}

onMount(() => {
  mobileQuery.addEventListener('change', handleBreakpointChange);

  return () => {
    mobileQuery.removeEventListener('change', handleBreakpointChange);
  };
});

$effect(() => {
  const inert = navInert;
  const wasInert = previousNavInert;

  previousNavInert = inert;

  // Focus must not stay on (or inside) a node that just became inert. The toggle is the
  // natural place for it: it is the control that brings the sidebar back.
  if (!wasInert && inert && sidebarElement?.contains(document.activeElement)) {
    document.getElementById(SIDEBAR_TOGGLE_ID)?.focus();
  }
});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if isMobile && appState.mobileSidebarOpen}
  <div
    class="mndw-sidebar-backdrop"
    role="presentation"
    onclick={closeOnMobile}
  >
  </div>
{/if}

<nav
  id={SIDEBAR_ID}
  bind:this={sidebarElement}
  class="mndw-sidebar"
  data-locale={appState.locale}
  class:collapsed={!isMobile && appState.desktopSidebarCollapsed}
  class:mobile-collapsed={isMobile && !appState.mobileSidebarOpen}
  inert={navInert}
  use:focusTrap={{enabled: isMobile && appState.mobileSidebarOpen}}
>
  <a
    href={HOST_PATHS.dashboard}
    class="mndw-sidebar__link"
    class:active={isActive(HOST_PATHS.dashboard)}
    aria-current={isActive(HOST_PATHS.dashboard) ? 'page' : undefined}
    onclick={closeOnMobile}
  >
    {hostT('nav.dashboard')}
  </a>

  <a
    href={HOST_PATHS.packages}
    class="mndw-sidebar__link"
    class:active={isActive(HOST_PATHS.packages)}
    aria-current={isActive(HOST_PATHS.packages) ? 'page' : undefined}
    onclick={closeOnMobile}
  >
    {hostT('nav.package-manager')}
  </a>

  {#if pagePlugins.length > 0}
    <div class="mndw-sidebar__section-label">{hostT('nav.plugins')}</div>
    {#each pagePlugins as plugin (plugin.name)}
      <a
        href={plugin.route}
        class="mndw-sidebar__link"
        class:active={isActive(plugin.route)}
        aria-current={isActive(plugin.route) ? 'page' : undefined}
        onclick={closeOnMobile}
      >
        {plugin.label}
        {#if plugin.failed}
          <mndw-icon
            class="mndw-sidebar__warning"
            name="circle-alert"
            title={hostT('nav.page-load-failed')}
            aria-hidden="true"
          ></mndw-icon>
          <span class="mndw-visually-hidden">{
            hostT('nav.page-load-failed')
          }</span>
        {/if}
      </a>
    {/each}
  {/if}

  <div class="mndw-sidebar__spacer"></div>
  <a
    href={HOST_PATHS.settings}
    class="mndw-sidebar__link"
    class:active={isActive(HOST_PATHS.settings)}
    aria-current={isActive(HOST_PATHS.settings) ? 'page' : undefined}
    onclick={closeOnMobile}
  >
    {hostT('nav.settings')}
  </a>
</nav>

<style>
.mndw-sidebar__warning {
  width: 1rem;
  height: 1rem;
  margin-inline-start: 0.375rem;
  vertical-align: middle;
}

.mndw-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
