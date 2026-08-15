import type {MndwPlugin} from '@mndw/sdk';
import {
  type PluginCatalogCell,
  type PluginCatalogService,
  pluginCatalogService,
} from '../services/plugin-catalog.service.js';
import type {PageListEntry, PluginListEntry, WidgetListEntry} from './plugin-types.js';

/** A plugin whose module has been imported and registered, keyed by its list entry. */
export interface LoadedPlugin {
  entry: PluginListEntry;
  module: MndwPlugin;
  catalog?: PluginCatalogCell;
}

export interface LoadedWidget extends LoadedPlugin {
  entry: WidgetListEntry;
}

export interface LoadedPage extends LoadedPlugin {
  entry: PageListEntry;
}

export type RegistryCatalog = Pick<
  PluginCatalogService,
  'registerPluginCatalogCell' | 'unregisterPluginCatalogCell' | 'clearPluginCatalogCells'
>;

export interface PluginRegistryDeps {
  catalog: RegistryCatalog;
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private readonly catalog: RegistryCatalog;

  constructor(deps: PluginRegistryDeps = {catalog: pluginCatalogService}) {
    this.catalog = deps.catalog;
  }

  public register(plugin: LoadedPlugin): void {
    if (this.plugins.has(plugin.entry.name)) {
      throw new Error(`Duplicate plugin name "${plugin.entry.name}"`);
    }

    this.plugins.set(plugin.entry.name, plugin);

    if (plugin.catalog !== undefined) {
      this.catalog.registerPluginCatalogCell(plugin.catalog);
    }
  }

  /**
   * Swaps an already-registered plugin's record for a new one (its freshly imported
   * module + manifest-derived entry), returning the prior record so a caller can roll
   * back on a failed hot-reload. Only compatible replacements are allowed: the name must
   * already exist, the type must not change, and a page's route must stay the same — a
   * topology-changing reload requires restarting `mndw dev`, and is rejected here so the
   * previous live plugin is never silently dropped.
   */
  public replace(plugin: LoadedPlugin): LoadedPlugin {
    const prior = this.plugins.get(plugin.entry.name);

    if (prior === undefined) {
      throw new Error(`Cannot replace unknown plugin "${plugin.entry.name}"`);
    }

    if (prior.entry.type !== plugin.entry.type) {
      throw new Error(
        `Cannot change plugin "${plugin.entry.name}" type from ${prior.entry.type} to ${plugin.entry.type}`,
      );
    }

    if (
      prior.entry.type === 'page'
      && plugin.entry.type === 'page'
      && prior.entry.route !== plugin.entry.route
    ) {
      throw new Error(
        `Cannot change page "${plugin.entry.name}" route from ${prior.entry.route} to ${plugin.entry.route}`,
      );
    }

    this.plugins.set(plugin.entry.name, plugin);

    if (prior.catalog !== undefined) {
      this.catalog.unregisterPluginCatalogCell(prior.catalog);
    }

    if (plugin.catalog !== undefined) {
      this.catalog.registerPluginCatalogCell(plugin.catalog);
    }

    return prior;
  }

  public get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  public getWidgets(): LoadedWidget[] {
    return [...this.plugins.values()].filter((p): p is LoadedWidget => p.entry.type === 'widget');
  }

  public getPages(): LoadedPage[] {
    return [...this.plugins.values()].filter((p): p is LoadedPage => p.entry.type === 'page');
  }

  public getAll(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  public clear(): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.catalog !== undefined) {
        this.catalog.unregisterPluginCatalogCell(plugin.catalog);
      }
    }

    this.plugins.clear();
    this.catalog.clearPluginCatalogCells();
  }
}

export function createPluginRegistry(deps: PluginRegistryDeps): PluginRegistry {
  return new PluginRegistry(deps);
}

export const pluginRegistry = new PluginRegistry();
