import {HOST_PATHS} from '../../router/host-routes.js';

export type PackageManagerTab = 'packages' | 'services';
export type PackageManagerPath = typeof HOST_PATHS.packages | typeof HOST_PATHS.packageServices;

export function packageManagerPath(tab: PackageManagerTab): PackageManagerPath {
  return tab === 'services' ? HOST_PATHS.packageServices : HOST_PATHS.packages;
}

export function packageManagerTabFromPath(pathname: string): PackageManagerTab | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (normalized === HOST_PATHS.packages) {
    return 'packages';
  }

  if (normalized === HOST_PATHS.packageServices) {
    return 'services';
  }

  return null;
}
