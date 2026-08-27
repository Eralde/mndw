import {type PackageManagerPath, type PackageManagerTab, packageManagerPath} from './package-manager-route.js';

export interface PackageManagerTabDefinition {
  readonly id: PackageManagerTab;
  readonly path: PackageManagerPath;
  readonly labelKey: string;
}

export const PACKAGE_MANAGER_TAB_DEFS: readonly PackageManagerTabDefinition[] = [
  {id: 'packages', path: packageManagerPath('packages'), labelKey: 'packages.tab'},
  {id: 'services', path: packageManagerPath('services'), labelKey: 'services.tab'},
] as const;
