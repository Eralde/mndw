<script lang="ts">
import {onDestroy} from 'svelte';
import {
  FALLBACK_DEVICE_INFO,
  FALLBACK_HOST_INFO,
  PAGE_PLUGIN_LOADING_DELAY_MS,
  PAGE_PLUGIN_SLOW_TIMEOUT_MS,
} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import type {HostInfo} from '../runtime/device-info-context.js';
import {
  type PluginMountHandle,
  mountPluginWithContext,
} from '../runtime/plugin-lifecycle.js';
import type {LoadedPlugin} from '../runtime/plugin-registry.js';
import {
  SANDBOX_RELOAD_EVENT,
  type SandboxReloadDetail,
} from '../runtime/sandbox-loader.js';
import {PageRouteController} from '../router/page-route-controller.js';
import {
  appRouter,
  getPageRouteDefinitions,
  getPluginNavigationRouter,
  resolvePageRoute,
} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {getHostServices} from '../host-services-context.js';
import {hostT} from '../services/host-i18n.svelte.js';

interface ActiveMount {
  generation: number;
  pluginName: string;
  child: HTMLElement;
  controller: PageRouteController;
  mount: PluginMountHandle | null;
}

/**
 * Host-owned state for the current mount generation. `pending` renders nothing;
 * `loading` is the 300 ms-grace indicator, `slow` replaces it after 10 s, and
 * `error` replaces it when createInstance fails.
 */
type MountStatus = 'none' | 'pending' | 'loading' | 'slow' | 'error';

/**
 * How a mount participates in the host-owned status UI. `full` reports loading, slow,
 * and error; `loading-only` reports loading/slow but keeps a failure silent.
 */
type MountStatusReporting = 'full' | 'loading-only';

const UNMOUNT_OPTIONS = {clearStorage: false,
  closeReason: 'host-navigation'} as const;

let host: HTMLElement | undefined;
let currentPluginName: string | null = null;
let generation = 0;
let active: ActiveMount | null = null;
let mountStatus = $state<MountStatus>('none');
let mountStatusPlugin = $state.raw<LoadedPlugin | null>(null);
let loadingTimer: ReturnType<typeof setTimeout> | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
const services = getHostServices();
const registry = services.registry;
const pluginContextServices = {
  locale: services.locale,
  palette: services.palette,
  telemetry: services.telemetry,
  telemetryGathering: services.telemetryGathering,
  eventStream: services.eventStream,
  navigation: getPluginNavigationRouter,
};

// Capture the host node via an action (not bind:this) so host-managed child containers
// can be appended imperatively — Svelte never renders into this element, so it does not
// diff the children the plugin runtime mounts (see OverlayShell for the same pattern).
function bindHost(node: HTMLElement): {destroy(): void} {
  host = node;

  return {
    destroy() {
      host = undefined;
    },
  };
}

const routeMatch = $derived.by(() => {
  return resolvePageRoute(appRouter.route.pathname, getPageRouteDefinitions());
});
const pluginName = $derived(routeMatch?.name ?? null);
const depsState = $derived.by(() => {
  return pluginName === null ? 'ready' : getDepsStatus(pluginName);
});
const mountTarget = $derived(depsState === 'ready' ? pluginName : null);

/**
 * Title shown by the status panels. Mirrors the sidebar's `entry.label` (the host does
 * not localize manifest labels), and is derived so a hot-reload candidate or a locale
 * switch re-reads it instead of freezing the title captured at mount time.
 */
const mountStatusTitle = $derived.by(() => {
  // Locale is a dependency so a switch re-derives the title with the panel copy.
  void appState.locale;

  return mountStatusPlugin?.entry.label ?? '';
});

/** The page region is busy while a mount is pending, loading, or past its deadline. */
const pageBusy = $derived(
  mountStatus === 'pending' || mountStatus === 'loading' || mountStatus === 'slow',
);

function clearMountTimers(): void {
  if (loadingTimer !== undefined) {
    clearTimeout(loadingTimer);
    loadingTimer = undefined;
  }

  if (slowTimer !== undefined) {
    clearTimeout(slowTimer);
    slowTimer = undefined;
  }
}

function resetMountStatus(): void {
  clearMountTimers();
  mountStatus = 'none';
  mountStatusPlugin = null;
}

/**
 * Arms the grace and slow-deadline timers for a mount generation. Both callbacks are
 * generation-guarded so no state from a superseded mount may ever show.
 */
function beginMountStatus(thisGeneration: number, plugin: LoadedPlugin): void {
  clearMountTimers();
  mountStatus = 'pending';
  mountStatusPlugin = plugin;

  loadingTimer = setTimeout(() => {
    if (thisGeneration === generation && mountStatus === 'pending') {
      mountStatus = 'loading';
    }
  }, PAGE_PLUGIN_LOADING_DELAY_MS);

  slowTimer = setTimeout(() => {
    if (
      thisGeneration === generation
      && (mountStatus === 'pending' || mountStatus === 'loading')
    ) {
      mountStatus = 'slow';
    }
  }, PAGE_PLUGIN_SLOW_TIMEOUT_MS);
}

// Each mount lives in its own child container inside the stable host, so disposing a
// stale generation only clears that generation's DOM — never the current page.
function disposeActive(): void {
  // A dependency status change can dispose without a replacement mount. Invalidate
  // pending async createInstance calls so late resolutions are always torn down.
  generation += 1;
  resetMountStatus();

  if (active === null) {
    return;
  }

  active.controller.complete();
  active.mount?.dispose(UNMOUNT_OPTIONS);
  active.child.remove();
  active = null;
}

function mountCurrent(target: string | null): void {
  currentPluginName = target;

  if (target === null) {
    return;
  }

  const plugin = registry.get(target);

  if (
    host === undefined || plugin === undefined || plugin.entry.type !== 'page'
  ) {
    return;
  }

  void mountPluginRecord(
    plugin,
    routeMatch?.name === target ? routeMatch.childPath : '',
  );
}

/**
 * Mounts a page plugin into a fresh child container, tracking it as the active mount, and
 * resolves once the mount settles: `true` when `createInstance` succeeded, `false` on
 * failure. A navigation that supersedes this mount before an async `createInstance` resolves
 * disposes the stale instance against its own child, leaving the current page untouched.
 *
 * When `statusReporting` is `loading-only` (sandbox hot-reload candidate) a failed mount
 * leaves no host-owned error panel; loading/slow still report so a hung candidate is visible
 * while the transaction waits.
 */
function mountPluginRecord(
  plugin: LoadedPlugin,
  initialChildPath: string,
  statusReporting: MountStatusReporting = 'full',
): Promise<boolean> {
  if (host === undefined) {
    return Promise.resolve(false);
  }

  generation += 1;
  const thisGeneration = generation;

  const child = document.createElement('div');

  child.className = 'mndw-page-plugin__mount';
  host.appendChild(child);

  const definition = getPageRouteDefinitions().find((route) =>
    route.name === plugin.entry.name
  );
  if (definition === undefined) {
    child.remove();

    return Promise.resolve(false);
  }

  beginMountStatus(thisGeneration, plugin);

  const controller = new PageRouteController(
    definition.route,
    initialChildPath,
    {
      navigate: (pathname, options) =>
        appRouter.navigate(pathname as never, options),
      getLocation: () => ({search: globalThis.location.search,
        hash: globalThis.location.hash}),
    },
  );
  const record: ActiveMount = {
    generation: thisGeneration,
    pluginName: plugin.entry.name,
    child,
    controller,
    mount: null,
  };

  active = record;

  const hostInfo: HostInfo = appState.hostInfo ?? FALLBACK_HOST_INFO;
  const deviceInfo = appState.deviceInfo ?? FALLBACK_DEVICE_INFO;
  const contextHandle = createPluginContext({
    entry: plugin.entry,
    instanceId: `${plugin.entry.name}:1`,
    hostInfo,
    deviceInfo,
    pageRoute: controller.pageRoute,
    catalogCell: plugin.catalog,
    services: pluginContextServices,
  });
  const mount = mountPluginWithContext(child, plugin, contextHandle);

  record.mount = mount;

  return mount.whenReady().then((ready) => {
    if (thisGeneration !== generation) {
      // The shared mount handle tears down late instances against their own child.
      child.remove();
    } else {
      clearMountTimers();

      if (ready) {
        mountStatus = 'none';
        mountStatusPlugin = null;
      } else if (statusReporting === 'full') {
        // Plugin-side error DOM (a partial render before createInstance failed)
        // must not stay visible alongside the host-owned error panel.
        child.replaceChildren();
        mountStatus = 'error';
      } else {
        // A failed hot-reload candidate stays silent: the caller immediately
        // disposes it and mounts the prior module, whose status is the final one.
        mountStatus = 'none';
        mountStatusPlugin = null;
      }
    }

    return ready;
  });
}

/**
 * Re-mounts the active page with a hot-reloaded module as one transaction: dispose the live
 * instance, mount the candidate, and on failure dispose it and remount the prior module (same
 * instance id, storage preserved). Reports success/failure back to the sandbox reload
 * coordinator so it can commit or roll back the registry.
 *
 * The candidate reports loading/slow but never its error: a failed candidate is followed by
 * a rollback, and the rollback reports the full status. A broken prior module therefore shows
 * the error panel + Retry instead of leaving the page blank.
 */
async function remountActivePage(
  next: LoadedPlugin,
  prior: LoadedPlugin,
): Promise<boolean> {
  disposeActive();

  if (await mountPluginRecord(next, routeMatch?.childPath ?? '', 'loading-only')) {
    return true;
  }

  disposeActive();
  await mountPluginRecord(prior, routeMatch?.childPath ?? '', 'full');

  return false;
}

/**
 * Disposes the failed/pending mount (its context signal aborts) and mounts again in a fresh
 * child container with the same instance id and preserved storage.
 */
function retryMount(): void {
  disposeActive();
  mountCurrent(mountTarget);
}

function handleSandboxReload(event: Event): void {
  const {detail} = event as CustomEvent<SandboxReloadDetail>;

  // Only the host currently showing the reloaded page acts; others leave it to their own.
  if (active === null || detail.pluginName !== currentPluginName) {
    return;
  }

  detail.register(remountActivePage(detail.next, detail.prior));
}

$effect(() => {
  // Track route + deps-status; remount only when effective target changes.
  if (mountTarget === currentPluginName) {
    return;
  }

  disposeActive();
  mountCurrent(mountTarget);
});

$effect(() => {
  const match = routeMatch;

  if (match !== null && active?.pluginName === match.name) {
    active.controller.setPath(match.childPath);
  }
});

$effect(() => {
  window.addEventListener(SANDBOX_RELOAD_EVENT, handleSandboxReload);

  return () =>
    window.removeEventListener(SANDBOX_RELOAD_EVENT, handleSandboxReload);
});

onDestroy(disposeActive);
</script>

<div class="mndw-page-plugin-wrap">
  {#if pluginName !== null && depsState !== 'ready'}
    <div
      class="mndw-page-plugin__notice"
      role={depsState === 'failed' ? 'alert' : 'status'}
    >
      {
        depsState === 'installing'
        ? hostT('dashboard.preparing-dependencies')
        : hostT('dashboard.dependency-install-failed')
      }
    </div>
  {:else if mountStatus === 'loading'}
    <div
      class="mndw-page-plugin__notice mndw-page-plugin__panel"
      role="status"
    >
      {hostT('page-plugin.opening', {title: mountStatusTitle})}
    </div>
  {:else if mountStatus === 'slow'}
    <div
      class="mndw-page-plugin__notice mndw-page-plugin__panel"
      role="alert"
    >
      <span>{hostT('page-plugin.slow')}</span>
      <mndw-button
        variant="secondary"
        onclick={retryMount}
      >
        {hostT('common.retry')}
      </mndw-button>
    </div>
  {:else if mountStatus === 'error'}
    <div
      class="mndw-page-plugin__notice mndw-page-plugin__panel"
      role="alert"
    >
      <span>{hostT('page-plugin.open-error', {title: mountStatusTitle})}</span>
      <mndw-button
        variant="secondary"
        onclick={retryMount}
      >
        {hostT('common.retry')}
      </mndw-button>
    </div>
  {/if}

  <div
    class="mndw-page-plugin"
    aria-busy={pageBusy ? 'true' : undefined}
    use:bindHost
  >
  </div>
</div>

<style>
.mndw-page-plugin__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  opacity: 1;
}
</style>
