import {isReservedPageRoute} from '@mndw/sdk-internal';
import {type RouteComponent, createRouter} from 'sv-router';
import DashboardPage from '../dashboard/DashboardPage.svelte';
import AppShell from '../layout/AppShell.svelte';
import PagePluginHost from '../pages/PagePluginHost.svelte';
import PackageManagerPage from '../pages/PackageManagerPage.svelte';
import SettingsPage from '../pages/settings/SettingsPage.svelte';
import {type PluginRegistry, pluginRegistry} from '../runtime/plugin-registry.js';
import {HOST_PATHS, type PluginPageTable} from './host-routes.js';

export interface PageRouteDefinition {
  readonly route: string;
  readonly name: string;
}

export interface PluginRoutesBuild {
  readonly routes: Record<string, RouteComponent>;
  readonly pageTable: PluginPageTable;
}

export type AppRouter = ReturnType<typeof createRouter> & {readonly pluginPages: PluginPageTable};

export let appRouter: AppRouter;

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
): PluginRoutesBuild {
  const pages = registry
    .getPages()
    .slice()
    .sort((a, b) => a.entry.label.localeCompare(b.entry.label) || a.entry.name.localeCompare(b.entry.name));

  const nextRoutes: Record<string, RouteComponent> = {};
  const nextMappings = new Map<string, string>();

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
  }

  const pluginNameToBaseRoute = new Map<string, string>();

  for (const [route, name] of nextMappings) {
    pluginNameToBaseRoute.set(name, route);
  }

  const pageTable: PluginPageTable = {
    baseRouteOf(pluginName: string): string | undefined {
      return pluginNameToBaseRoute.get(pluginName);
    },
    pluginNameOf(baseRoute: string): string | undefined {
      return nextMappings.get(canonicalBaseRoute(baseRoute));
    },
  };

  return {routes: nextRoutes, pageTable};
}

export function getPageRouteDefinitions(): readonly PageRouteDefinition[] {
  return pluginRegistry.getPages().flatMap((page) => {
    const route = appRouter.pluginPages.baseRouteOf(page.entry.name);

    if (route === undefined) {
      return [];
    }

    return [{route, name: page.entry.name}];
  });
}

/** Build all authenticated route entries except the shared AppShell layout wrapper. */
export function buildHostRouteTable(
  pluginRoutes: Record<string, RouteComponent>,
): Record<string, RouteComponent> {
  return {
    [HOST_PATHS.dashboard]: DashboardPage,
    [HOST_PATHS.login]: DashboardPage,
    [HOST_PATHS.packages]: PackageManagerPage,
    [HOST_PATHS.packageServices]: PackageManagerPage,
    [HOST_PATHS.settings]: SettingsPage,
    ...Object.fromEntries(Object.values(HOST_PATHS.settingsTab).map((path) => [path, SettingsPage])),
    ...pluginRoutes,
    '*': DashboardPage,
  };
}

function stripOneTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function resolvePageRoute(
  pathname: string,
  routesOrPageTable: readonly PageRouteDefinition[] | PluginPageTable,
): {name: string; childPath: string} | null {
  const normalizedPathname = stripOneTrailingSlash(pathname);
  const segmentEnd = normalizedPathname.indexOf('/', 1);
  const baseRoute = segmentEnd === -1 ? normalizedPathname : normalizedPathname.slice(0, segmentEnd);
  let name: string | undefined;

  if ('pluginNameOf' in routesOrPageTable) {
    name = routesOrPageTable.pluginNameOf(baseRoute);
  } else {
    name = routesOrPageTable.find((route) => canonicalBaseRoute(route.route) === canonicalBaseRoute(baseRoute))?.name;
  }

  if (name === undefined) {
    return null;
  }

  const childPath = normalizedPathname.slice(baseRoute.length);

  return {name, childPath: childPath === '/' ? '' : childPath};
}

/** Repair malformed raw browser paths before sv-router decodes wildcard captures. */
export function repairMalformedPagePath(): void {
  const pathname = globalThis.location.pathname;
  const match = resolvePageRoute(pathname, appRouter.pluginPages);

  if (match === null) {
    return;
  }

  try {
    decodeURIComponent(pathname);
  } catch (_error) {
    const baseRoute = appRouter.pluginPages.baseRouteOf(match.name);

    if (baseRoute === undefined) {
      return;
    }

    globalThis.history.replaceState(
      globalThis.history.state,
      '',
      `${baseRoute}${globalThis.location.search}${globalThis.location.hash}`,
    );
  }
}

/**
 * Build authenticated app router. Must run after loadPlugins() so registry is populated.
 * Malformed page wildcard paths are repaired before Router's initial navigation can decode them.
 */
export function createAppRouter(
  registry: Pick<PluginRegistry, 'getPages'> = pluginRegistry,
): AppRouter {
  const {routes: pluginRoutes, pageTable} = buildPluginRoutes(registry);
  const hostRoutes = buildHostRouteTable(pluginRoutes);

  const router = createRouter({
    [HOST_PATHS.dashboard]: {
      layout: AppShell,
      ...hostRoutes,
    },
  });

  appRouter = Object.assign(router, {pluginPages: pageTable});
  repairMalformedPagePath();

  return appRouter;
}
