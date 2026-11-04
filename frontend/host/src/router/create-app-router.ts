import {isReservedPageRoute} from '@mndw/sdk-internal';
import {createRouter} from 'sv-router';
import DashboardPage from '../dashboard/DashboardPage.svelte';
import AppShell from '../layout/AppShell.svelte';
import PagePluginHost from '../pages/PagePluginHost.svelte';
import PackageManagerPage from '../pages/PackageManagerPage.svelte';
import SettingsPage from '../pages/settings/SettingsPage.svelte';
import {SETTINGS_TAB_DEFS} from '../pages/settings/settings-tabs.js';
import {type PluginRegistry, pluginRegistry} from '../runtime/plugin-registry.js';

export interface PageRouteDefinition {
  readonly route: string;
  readonly name: string;
}

/** Maps a page plugin's canonical absolute base route to its canonical entry name. */
export const routeToPluginName = new Map<string, string>();

let pageRouteDefinitions: readonly PageRouteDefinition[] = [];

export let appRouter: ReturnType<typeof createRouter>;

function canonicalBaseRoute(route: string): string {
  const withoutTrailingSlash = route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;

  return withoutTrailingSlash.toLowerCase();
}

function assertPageBaseRoute(route: string, name: string): void {
  if (!/^\/[^/?#*]+\/?$/.test(route) || canonicalBaseRoute(route) === '/') {
    throw new Error(`Page plugin "${name}" must declare a single-segment route; received "${route}"`);
  }
}

function assertRouteIsAvailable(route: string, name: string): void {
  if (isReservedPageRoute(route)) {
    throw new Error(`Page plugin "${name}" route "${route}" conflicts with a reserved static route`);
  }
}

/**
 * Builds dynamic page-plugin routes from registry, sorted by label then name. Each page gets
 * exact and child-wildcard entries, both resolving to shared {@link PagePluginHost}.
 */
export function buildPluginRoutes(
  registry: Pick<PluginRegistry, 'getPages'> = pluginRegistry,
): Record<string, typeof PagePluginHost> {
  const pages = registry
    .getPages()
    .slice()
    .sort((a, b) => a.entry.label.localeCompare(b.entry.label) || a.entry.name.localeCompare(b.entry.name));

  const nextRoutes: Record<string, typeof PagePluginHost> = {};
  const nextMappings = new Map<string, string>();
  const nextDefinitions: PageRouteDefinition[] = [];

  for (const page of pages) {
    const {name, route} = page.entry;

    assertPageBaseRoute(route, name);
    assertRouteIsAvailable(canonicalBaseRoute(route), name);

    const baseRoute = canonicalBaseRoute(route);
    const wildcardRoute = `${baseRoute}/*child`;
    const existingName = nextMappings.get(baseRoute);

    if (existingName !== undefined) {
      throw new Error(
        `Page route collision: plugin "${name}" route "${route}" conflicts with plugin "${existingName}" route "${baseRoute}"`,
      );
    }

    nextRoutes[baseRoute] = PagePluginHost;
    nextRoutes[wildcardRoute] = PagePluginHost;
    nextMappings.set(baseRoute, name);
    nextDefinitions.push({route: baseRoute, name});
  }

  routeToPluginName.clear();

  for (const [route, name] of nextMappings) {
    routeToPluginName.set(route, name);
  }

  pageRouteDefinitions = nextDefinitions;

  return nextRoutes;
}

export function getPageRouteDefinitions(): readonly PageRouteDefinition[] {
  return pageRouteDefinitions;
}

function stripOneTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function resolvePageRoute(
  pathname: string,
  routes: readonly PageRouteDefinition[],
): {name: string; childPath: string} | null {
  const normalizedPathname = stripOneTrailingSlash(pathname);
  const lowerPathname = normalizedPathname.toLowerCase();

  for (const route of routes) {
    const baseRoute = canonicalBaseRoute(route.route);
    const lowerBaseRoute = baseRoute.toLowerCase();

    if (lowerPathname === lowerBaseRoute) {
      return {name: route.name, childPath: ''};
    }

    const prefix = `${lowerBaseRoute}/`;

    if (lowerPathname.startsWith(prefix)) {
      const childPath = normalizedPathname.slice(baseRoute.length);

      return {name: route.name, childPath: childPath === '/' ? '' : childPath};
    }
  }

  return null;
}

/** Repair malformed raw browser paths before sv-router decodes wildcard captures. */
export function repairMalformedPagePath(): void {
  const pathname = globalThis.location.pathname;
  const match = resolvePageRoute(pathname, pageRouteDefinitions);

  if (match === null) {
    return;
  }

  try {
    decodeURIComponent(pathname);
  } catch (_error) {
    const definition = pageRouteDefinitions.find((route) => route.name === match.name);

    if (definition === undefined) {
      return;
    }

    globalThis.history.replaceState(
      globalThis.history.state,
      '',
      `${definition.route}${globalThis.location.search}${globalThis.location.hash}`,
    );
  }
}

/**
 * Build authenticated app router. Must run after loadPlugins() so registry is populated.
 * Malformed page wildcard paths are repaired before Router's initial navigation can decode them.
 */
export function createAppRouter(
  registry: Pick<PluginRegistry, 'getPages'> = pluginRegistry,
): ReturnType<typeof createRouter> {
  const pluginRoutes = buildPluginRoutes(registry);

  const router = createRouter({
    '/': {
      'layout': AppShell,
      '/': DashboardPage,
      '/packages': PackageManagerPage,
      '/packages/services': PackageManagerPage,
      '/settings': SettingsPage,
      ...Object.fromEntries(SETTINGS_TAB_DEFS.map((tab) => [tab.route, SettingsPage])),
      ...pluginRoutes,
      '*': DashboardPage,
    },
  });

  appRouter = router;
  repairMalformedPagePath();

  return router;
}
