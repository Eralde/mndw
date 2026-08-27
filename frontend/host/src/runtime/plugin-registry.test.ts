import {beforeEach, describe, expect, it} from 'vitest';
import {type LoadedPlugin, PluginRegistry} from './plugin-registry.js';
import type {PluginCatalogCell} from '../services/plugin-catalog.service.js';
import type {PluginBackendDescriptor} from './plugin-types.js';

const emptyBackend: PluginBackendDescriptor = {
  routes: {},
};

function widgetPlugin(name = 'test-widget'): LoadedPlugin {
  return {
    entry: {
      name,
      type: 'widget',
      version: '1.0.0',
      label: 'Test Widget',
      entry: 'index.js',
      source: 'builtin',
      approval: 'approved',
      enabled: true,
      depsStatus: 'ready',
      size: {w: 4, h: 3},
      backend: emptyBackend,
    },
    module: {createInstance: () => ({unmount: () => {}})},
  };
}

function pagePlugin(name: string, route: string): LoadedPlugin {
  return {
    entry: {
      name,
      type: 'page',
      version: '1.0.0',
      label: `Test ${name}`,
      entry: 'index.js',
      source: 'builtin',
      approval: 'approved',
      enabled: true,
      depsStatus: 'ready',
      route,
      backend: emptyBackend,
    },
    module: {createInstance: () => ({unmount: () => {}})},
  };
}

let registry: PluginRegistry;

beforeEach(() => {
  registry = new PluginRegistry();
});

describe('PluginRegistry', () => {
  it('register() forwards catalog cells to the injected collaborator', () => {
    const registered: PluginCatalogCell[] = [];
    const catalog = {
      registerPluginCatalogCell: (cell: PluginCatalogCell): void => {
        registered.push(cell);
      },
      unregisterPluginCatalogCell: (): void => {},
      clearPluginCatalogCells: (): void => {},
    };
    const injected = new PluginRegistry({catalog});
    const cell = {} as PluginCatalogCell;

    injected.register({...widgetPlugin('catalog'), catalog: cell});

    expect(registered).toEqual([cell]);
  });

  it('clear() uses the injected catalog collaborator', () => {
    const unregistered: PluginCatalogCell[] = [];
    let cleared = 0;
    const catalog = {
      registerPluginCatalogCell: (): void => {},
      unregisterPluginCatalogCell: (cell: PluginCatalogCell): void => {
        unregistered.push(cell);
      },
      clearPluginCatalogCells: (): void => {
        cleared += 1;
      },
    };
    const injected = new PluginRegistry({catalog});
    const cell = {} as PluginCatalogCell;

    injected.register({...widgetPlugin('catalog'), catalog: cell});
    injected.clear();

    expect(unregistered).toEqual([cell]);
    expect(cleared).toBe(1);
  });

  it('new PluginRegistry() remains default-constructible', () => {
    expect(() => new PluginRegistry()).not.toThrow();
  });

  it('register() adds a plugin to the registry', () => {
    const plugin = widgetPlugin('my-plugin');

    registry.register(plugin);

    expect(registry.get('my-plugin')).toBe(plugin);
  });

  it('register() throws on duplicate plugin names', () => {
    registry.register(widgetPlugin('dup'));

    expect(() => registry.register(widgetPlugin('dup'))).toThrow('Duplicate plugin name');
  });

  it('get() returns the correct plugin by name', () => {
    const a = widgetPlugin('a');
    const b = widgetPlugin('b');

    registry.register(a);
    registry.register(b);

    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
  });

  it('get() returns undefined for unknown names', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getWidgets() returns only widget entries', () => {
    registry.register(widgetPlugin('w1'));
    registry.register(widgetPlugin('w2'));
    registry.register(pagePlugin('p1', '/test'));

    const widgets = registry.getWidgets();

    expect(widgets).toHaveLength(2);
    expect(widgets.every((w) => w.entry.type === 'widget')).toBe(true);
  });

  it('getPages() returns only page entries', () => {
    registry.register(pagePlugin('p1', '/test'));
    registry.register(pagePlugin('p2', '/other'));
    registry.register(widgetPlugin('w1'));

    const pages = registry.getPages();

    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.entry.type === 'page')).toBe(true);
  });

  it('getAll() returns all registered plugins', () => {
    registry.register(widgetPlugin('w1'));
    registry.register(pagePlugin('p1', '/test'));

    expect(registry.getAll()).toHaveLength(2);
  });

  it('clear() empties the registry', () => {
    registry.register(widgetPlugin('w1'));
    expect(registry.getAll()).toHaveLength(1);

    registry.clear();

    expect(registry.getAll()).toHaveLength(0);
  });

  describe('replace()', () => {
    it('swaps a plugin record in place and returns the prior record', () => {
      const prior = widgetPlugin('hot');

      registry.register(prior);

      const next = widgetPlugin('hot');

      const returned = registry.replace(next);

      expect(returned).toBe(prior);
      expect(registry.get('hot')).toBe(next);
    });

    it('throws when replacing an unknown plugin', () => {
      expect(() => registry.replace(widgetPlugin('ghost'))).toThrow('Cannot replace unknown plugin');
    });

    it('throws when the replacement changes the plugin type', () => {
      registry.register(widgetPlugin('shape'));

      expect(() => registry.replace(pagePlugin('shape', '/shape'))).toThrow(
        'Cannot change plugin "shape" type',
      );
      // The original widget record stays registered on rejection.
      expect(registry.get('shape')?.entry.type).toBe('widget');
    });

    it('throws when the replacement changes a page route', () => {
      registry.register(pagePlugin('docs', '/docs'));

      expect(() => registry.replace(pagePlugin('docs', '/guide'))).toThrow(
        'Cannot change page "docs" route',
      );
      expect((registry.get('docs')?.entry as {route: string}).route).toBe('/docs');
    });

    it('accepts a page replacement that keeps name, type, and route', () => {
      registry.register(pagePlugin('docs', '/docs'));

      const next = pagePlugin('docs', '/docs');

      expect(() => registry.replace(next)).not.toThrow();
      expect(registry.get('docs')).toBe(next);
    });
  });
});
