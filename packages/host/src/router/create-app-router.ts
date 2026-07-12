import {createRouter} from 'sv-router';
import DashboardPage from '../dashboard/DashboardPage.svelte';
import AppShell from '../layout/AppShell.svelte';
import PagePluginHost from '../pages/PagePluginHost.svelte';
import SettingsPage from '../pages/settings/SettingsPage.svelte';
import {pluginRegistry} from '../runtime/plugin-registry.js';

/** Maps a page plugin's absolute `entry.route` back to its canonical `entry.name`. */
export const routeToPluginName = new Map<string, string>();

export let appRouter: ReturnType<typeof createRouter>;

/**
 * Builds the dynamic page-plugin routes from the registry, sorted by `entry.label` then
 * `entry.name`, and rebuilds {@link routeToPluginName}. Every page route resolves to the
 * shared {@link PagePluginHost}, which mounts the plugin named by the current route.
 * Widget plugins never become routes. Exported so route construction is unit-testable
 * without inspecting sv-router internals.
 */
export function buildPluginRoutes(): Record<string, typeof PagePluginHost> {
  routeToPluginName.clear();

  const pages = pluginRegistry
    .getPages()
    .slice()
    .sort((a, b) => a.entry.label.localeCompare(b.entry.label) || a.entry.name.localeCompare(b.entry.name));

  const routes: Record<string, typeof PagePluginHost> = {};

  for (const page of pages) {
    routes[page.entry.route] = PagePluginHost;
    routeToPluginName.set(page.entry.route, page.entry.name);
  }

  return routes;
}

/**
 * Build the authenticated app router: the static shell routes (`/`, `/settings`, `*`)
 * plus one route per loaded page plugin. Must run after `loadPlugins()` so the registry
 * is populated (see init-auth).
 */
export function createAppRouter(): ReturnType<typeof createRouter> {
  const pluginRoutes = buildPluginRoutes();

  const router = createRouter({
    '/': {
      'layout': AppShell,
      '/': DashboardPage,
      '/settings': SettingsPage,
      ...pluginRoutes,
      '*': DashboardPage,
    },
  });

  appRouter = router;

  return router;
}
