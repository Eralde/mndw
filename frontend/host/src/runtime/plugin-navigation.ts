import type {HostNavigation, HostTarget} from '@mndw/sdk';
import {HOST_PATHS, type PluginPageTable, type SettingsTabId} from '../router/host-routes.js';

export interface PluginNavigationRouter {
  readonly pageTable: PluginPageTable;
  navigate(pathname: string): unknown;
}

export interface CreatePluginNavigationDeps {
  getRouter(): PluginNavigationRouter | undefined;
  isDisposed(): boolean;
}

const SETTINGS_TABS: Readonly<Record<SettingsTabId, string>> = HOST_PATHS.settingsTab;
const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

function validChildPath(path: string): string | undefined {
  if (path === '') {
    return '';
  }

  if (
    path.startsWith('/')
    || path.includes('\\')
    || path.includes('?')
    || path.includes('#')
    || SCHEME_PATTERN.test(path)
  ) {
    return undefined;
  }

  const withoutTrailingSlash = path.endsWith('/') ? path.slice(0, -1) : path;

  if (withoutTrailingSlash === '') {
    return undefined;
  }

  const segments = withoutTrailingSlash.split('/');

  for (const segment of segments) {
    if (segment === '') {
      return undefined;
    }

    let decodedSegment: string;

    try {
      decodedSegment = decodeURIComponent(segment);
    } catch (_error) {
      return undefined;
    }

    if (
      decodedSegment === '.'
      || decodedSegment === '..'
      || decodedSegment.includes('/')
      || decodedSegment.includes('\\')
    ) {
      return undefined;
    }
  }

  return withoutTrailingSlash;
}

function targetPath(target: unknown, router: PluginNavigationRouter): string | undefined {
  try {
    if (typeof target !== 'object' || target === null) {
      return undefined;
    }

    const candidate = target as Record<string, unknown>;

    switch (candidate.kind) {
      case 'dashboard':
        return HOST_PATHS.dashboard;
      case 'packages':
        return HOST_PATHS.packages;
      case 'settings': {
        const tab = candidate.tab;

        if (tab === undefined) {
          return HOST_PATHS.settings;
        }

        if (typeof tab !== 'string' || !Object.hasOwn(SETTINGS_TABS, tab)) {
          return undefined;
        }

        return SETTINGS_TABS[tab as SettingsTabId];
      }
      case 'plugin-page': {
        if (typeof candidate.plugin !== 'string') {
          return undefined;
        }

        const baseRoute = router.pageTable.baseRouteOf(candidate.plugin);

        if (baseRoute === undefined) {
          return undefined;
        }

        const path = candidate.path;

        if (path !== undefined && typeof path !== 'string') {
          return undefined;
        }

        const childPath = validChildPath(path ?? '');

        if (childPath === undefined) {
          return undefined;
        }

        return childPath === '' ? baseRoute : `${baseRoute}/${childPath}`;
      }
      default:
        return undefined;
    }
  } catch (_error) {
    return undefined;
  }
}

function resolveTarget(
  target: unknown,
  deps: CreatePluginNavigationDeps,
): {router: PluginNavigationRouter; path: string} | undefined {
  try {
    const router = deps.getRouter();

    if (router === undefined) {
      return undefined;
    }

    const path = targetPath(target, router);

    if (path === undefined) {
      return undefined;
    }

    return {router, path};
  } catch (_error) {
    return undefined;
  }
}

export function createPluginNavigation(deps: CreatePluginNavigationDeps): HostNavigation {
  return Object.freeze({
    href: (target: HostTarget): string | undefined => resolveTarget(target, deps)?.path,
    navigate: (target: HostTarget): boolean => {
      try {
        if (deps.isDisposed()) {
          return false;
        }

        const resolved = resolveTarget(target, deps);

        if (resolved === undefined) {
          return false;
        }

        void resolved.router.navigate(resolved.path);

        return true;
      } catch (_error) {
        return false;
      }
    },
  });
}
