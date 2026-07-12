import {beforeEach, describe, expect, it} from 'vitest';
import {type LoadedPlugin, PluginRegistry} from './plugin-registry.js';
import type {PluginBackendDescriptor} from './plugin-types.js';

const emptyBackend: PluginBackendDescriptor = {
  endpoints: {},
  websockets: {},
  opkg: [],
  daemon: false,
  public: false,
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
});
