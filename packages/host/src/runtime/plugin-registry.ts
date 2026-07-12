import type {MndwPlugin} from '@mndw/sdk';
import type {PageListEntry, PluginListEntry, WidgetListEntry} from './plugin-types.js';

/** A plugin whose module has been imported and registered, keyed by its list entry. */
export interface LoadedPlugin {
  entry: PluginListEntry;
  module: MndwPlugin;
}

export interface LoadedWidget extends LoadedPlugin {
  entry: WidgetListEntry;
}

export interface LoadedPage extends LoadedPlugin {
  entry: PageListEntry;
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();

  public register(plugin: LoadedPlugin): void {
    if (this.plugins.has(plugin.entry.name)) {
      throw new Error(`Duplicate plugin name "${plugin.entry.name}"`);
    }

    this.plugins.set(plugin.entry.name, plugin);
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
    this.plugins.clear();
  }
}

export const pluginRegistry = new PluginRegistry();
