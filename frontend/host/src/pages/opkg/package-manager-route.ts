export type PackageManagerTab = 'packages' | 'services';
export type PackageManagerPath = '/packages' | '/packages/services';

export function packageManagerPath(tab: PackageManagerTab): PackageManagerPath {
  return tab === 'services' ? '/packages/services' : '/packages';
}

export function packageManagerTabFromPath(pathname: string): PackageManagerTab | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (normalized === '/packages') {
    return 'packages';
  }

  if (normalized === '/packages/services') {
    return 'services';
  }

  return null;
}
