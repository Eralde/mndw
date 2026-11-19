import {PluginRegistry, type RegistryCatalog} from '../runtime/plugin-registry.js';

export function createTestPluginRegistry(): PluginRegistry {
  const catalog: RegistryCatalog = {
    registerPluginCatalogCell: (): void => {},
    unregisterPluginCatalogCell: (): void => {},
    clearPluginCatalogCells: (): void => {},
  };

  return new PluginRegistry({catalog});
}
