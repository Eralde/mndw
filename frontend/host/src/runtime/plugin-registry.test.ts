// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from 'vitest';
import {type LoadedPlugin, PluginRegistry} from './plugin-registry.js';
import type {PluginCatalogCell} from '../services/plugin-catalog.service.js';
import type {PluginBackendDescriptor} from './plugin-types.js';
import {PluginStylesheets} from './plugin-stylesheets.js';
import {createTestPluginRegistry} from '../testing/plugin-registry.js';

const pluginStylesheets = new PluginStylesheets();

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
  (window as unknown as {happyDOM: {settings: {disableCSSFileLoading: boolean}}})
    .happyDOM.settings.disableCSSFileLoading = true;
  registry = createTestPluginRegistry();
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

  it('remove() unregisters a plugin and its catalog cell', () => {
    const cell = {} as PluginCatalogCell;
    const unregistered: PluginCatalogCell[] = [];
    const catalog = {
      registerPluginCatalogCell: (): void => {},
      unregisterPluginCatalogCell: (value: PluginCatalogCell): void => {
        unregistered.push(value);
      },
      clearPluginCatalogCells: (): void => {},
    };
    const injected = new PluginRegistry({catalog});
    const plugin = {...widgetPlugin('removed'), catalog: cell};

    injected.register(plugin);

    expect(injected.remove('removed')).toBe(plugin);
    expect(injected.get('removed')).toBeUndefined();
    expect(injected.getWidgets()).toEqual([]);
    expect(unregistered).toEqual([cell]);
    expect(injected.remove('missing')).toBeUndefined();
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

describe('PluginRegistry stylesheet ownership', () => {
  function loadedStylesheet(
    name: string,
    version = '1.0.0',
  ): {link: HTMLLinkElement; lease: ReturnType<typeof pluginStylesheets.acquire>} {
    const lease = pluginStylesheets.acquire(name, version, `/${name}.css?v=${version}`);
    const link = document.head.querySelector<HTMLLinkElement>(`link[data-plugin-style="${name}"]`);

    if (link === null) {
      throw new Error(`Stylesheet for ${name} was not added`);
    }

    link.dispatchEvent(new Event('load'));

    return {link, lease};
  }

  it('releases the removed plugin stylesheet', () => {
    const {link, lease} = loadedStylesheet('removed');

    registry.register({...widgetPlugin('removed'), stylesheetLease: lease});
    registry.remove('removed');

    expect(link.isConnected).toBe(false);
  });

  it('releases every registered plugin stylesheet when cleared', () => {
    const first = loadedStylesheet('clear-first');
    const second = loadedStylesheet('clear-second');

    registry.register({...widgetPlugin('clear-first'), stylesheetLease: first.lease});
    registry.register({...widgetPlugin('clear-second'), stylesheetLease: second.lease});
    registry.clear();

    expect(first.link.isConnected).toBe(false);
    expect(second.link.isConnected).toBe(false);
  });

  it('releases the prior stylesheet when the plugin version changes', () => {
    const {link: priorLink, lease} = loadedStylesheet('versioned');
    const prior = widgetPlugin('versioned');
    const next = widgetPlugin('versioned');

    prior.stylesheetLease = lease;
    next.entry.version = '2.0.0';

    registry.register(prior);
    registry.replace(next);

    expect(priorLink.isConnected).toBe(false);
  });

  it('keeps same-version stylesheet ownership through replacement', () => {
    const {link, lease} = loadedStylesheet('same-version');
    const prior = widgetPlugin('same-version');

    prior.stylesheetLease = lease;
    registry.register(prior);
    registry.replace(widgetPlugin('same-version'));

    expect(link.isConnected).toBe(true);

    registry.remove('same-version');

    expect(link.isConnected).toBe(false);
  });
});
