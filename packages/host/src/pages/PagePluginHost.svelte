<script lang="ts">
import type {HostInfo} from '@mndw/sdk';
import {onDestroy} from 'svelte';
import {FALLBACK_HOST_INFO} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import {
  type MountedPlugin,
  mountPlugin,
  unmountPlugin,
} from '../runtime/plugin-lifecycle.js';
import {pluginRegistry} from '../runtime/plugin-registry.js';
import {appRouter, routeToPluginName} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';

interface ActiveMount {
  generation: number;
  child: HTMLElement;
  mounted: MountedPlugin | null;
}

const UNMOUNT_OPTIONS = {clearStorage: false,
  closeReason: 'host-navigation'} as const;

let host: HTMLElement | undefined;
let currentPluginName: string | null = null;
let generation = 0;
let active: ActiveMount | null = null;

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

const pluginName = $derived(
  routeToPluginName.get(appRouter.route.pathname) ?? null,
);

// Each mount lives in its own child container inside the stable host, so disposing a
// stale generation only clears that generation's DOM — never the current page.
function disposeActive(): void {
  if (active === null) {
    return;
  }

  unmountPlugin(active.mounted, active.child, UNMOUNT_OPTIONS);
  active.child.remove();
  active = null;
}

function mountCurrent(): void {
  currentPluginName = pluginName;

  if (pluginName === null) {
    return;
  }

  const plugin = pluginRegistry.get(pluginName);

  if (
    host === undefined || plugin === undefined || plugin.entry.type !== 'page'
  ) {
    return;
  }

  generation += 1;
  const thisGeneration = generation;

  const child = document.createElement('div');

  child.className = 'mndw-page-plugin__mount';
  host.appendChild(child);

  const record: ActiveMount = {generation: thisGeneration, child,
    mounted: null};

  active = record;

  const hostInfo: HostInfo = appState.hostInfo ?? FALLBACK_HOST_INFO;
  const context = createPluginContext(
    plugin.entry,
    `${pluginName}:1`,
    hostInfo,
  );
  const result = mountPlugin(child, plugin, context);

  if (result instanceof Promise) {
    void result.then((nextMounted) => {
      if (thisGeneration !== generation) {
        // Superseded by a newer navigation before resolving: dispose against this
        // generation's own child so the current page's DOM is untouched.
        unmountPlugin(nextMounted, child, UNMOUNT_OPTIONS);
        child.remove();

        return;
      }

      record.mounted = nextMounted;
    });

    return;
  }

  record.mounted = result;
}

$effect(() => {
  // Track the reactive route; re-mount only when the resolved plugin actually changes.
  if (pluginName === currentPluginName) {
    return;
  }

  disposeActive();
  mountCurrent();
});

onDestroy(disposeActive);
</script>

<div
  class="mndw-page-plugin"
  use:bindHost
>
</div>
