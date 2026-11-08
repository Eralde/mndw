<script lang="ts">
import {onDestroy} from 'svelte';
import {FALLBACK_DEVICE_INFO, FALLBACK_HOST_INFO} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import type {HostInfo} from '../runtime/device-info-context.js';
import {
  type MountedPlugin,
  mountPlugin,
  unmountPlugin,
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
  resolvePageRoute,
} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {getHostServices} from '../host-services-context.js';

interface ActiveMount {
  generation: number;
  pluginName: string;
  child: HTMLElement;
  controller: PageRouteController;
  mounted: MountedPlugin | null;
}

const UNMOUNT_OPTIONS = {clearStorage: false,
  closeReason: 'host-navigation'} as const;

let host: HTMLElement | undefined;
let currentPluginName: string | null = null;
let generation = 0;
let active: ActiveMount | null = null;
const services = getHostServices();
const registry = services.registry;
const pluginContextServices = {
  locale: services.locale,
  palette: services.palette,
  telemetry: services.telemetry,
  eventStream: services.eventStream,
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

// Each mount lives in its own child container inside the stable host, so disposing a
// stale generation only clears that generation's DOM — never the current page.
function disposeActive(): void {
  // A dependency status change can dispose without a replacement mount. Invalidate
  // pending async createInstance calls so late resolutions are always torn down.
  generation += 1;

  if (active === null) {
    return;
  }

  active.controller.complete();
  unmountPlugin(active.mounted, active.child, UNMOUNT_OPTIONS);
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
 */
function mountPluginRecord(
  plugin: LoadedPlugin,
  initialChildPath: string,
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
    mounted: null,
  };

  active = record;

  const hostInfo: HostInfo = appState.hostInfo ?? FALLBACK_HOST_INFO;
  const deviceInfo = appState.deviceInfo ?? FALLBACK_DEVICE_INFO;
  const {context, dispose} = createPluginContext({
    entry: plugin.entry,
    instanceId: `${plugin.entry.name}:1`,
    hostInfo,
    deviceInfo,
    pageRoute: controller.pageRoute,
    catalogCell: plugin.catalog,
    services: pluginContextServices,
  });
  const result = mountPlugin(child, plugin, context, dispose);

  if (result instanceof Promise) {
    return result.then((nextMounted) => {
      if (thisGeneration !== generation) {
        // Superseded by a newer navigation before resolving: dispose against this
        // generation's own child so the current page's DOM is untouched.
        unmountPlugin(nextMounted, child, UNMOUNT_OPTIONS);
        child.remove();

        return nextMounted !== null;
      }

      record.mounted = nextMounted;

      return nextMounted !== null;
    });
  }

  record.mounted = result;

  return Promise.resolve(result !== null);
}

/**
 * Re-mounts the active page with a hot-reloaded module as one transaction: dispose the live
 * instance, mount the candidate, and on failure dispose it and remount the prior module (same
 * instance id, storage preserved). Reports success/failure back to the sandbox reload
 * coordinator so it can commit or roll back the registry.
 */
async function remountActivePage(
  next: LoadedPlugin,
  prior: LoadedPlugin,
): Promise<boolean> {
  disposeActive();

  if (await mountPluginRecord(next, routeMatch?.childPath ?? '')) {
    return true;
  }

  disposeActive();
  await mountPluginRecord(prior, routeMatch?.childPath ?? '');

  return false;
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
      role="status"
    >
      {
        depsState === 'installing'
        ? 'Preparing… installing dependencies'
        : 'Dependency install failed'
      }
    </div>
  {/if}

  <div
    class="mndw-page-plugin"
    use:bindHost
  >
  </div>
</div>
