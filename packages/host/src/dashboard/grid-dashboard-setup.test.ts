/* eslint id-blacklist: 0 */
import type {GridStack, GridStackWidget} from 'gridstack';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {get: vi.fn()},
}));

vi.mock('./widget-counter.js', () => ({
  getNextInstanceId: vi.fn(),
  raiseInstanceCounter: vi.fn(),
}));

vi.mock('./widget-context.js', () => ({
  createWidgetContext: vi.fn((_name: string, instanceId: string) => ({instanceId})),
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn((_entry: unknown, instanceId: string) => ({instanceId})),
  consumeOverlayDispose: () => () => {},
}));

// Spy-wrap the real lifecycle so error-tile tests exercise the real mount (which renders
// the error text) while remove/teardown tests can still assert the dispose options.
vi.mock('../runtime/plugin-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/plugin-lifecycle.js')>();

  return {...actual, mountPlugin: vi.fn(actual.mountPlugin), unmountPlugin: vi.fn(actual.unmountPlugin)};
});

import type {PluginInstance} from '@mndw/sdk';
import {unmountPlugin} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry, WidgetListEntry} from '../runtime/plugin-types.js';
import {
  type RestoredTilePosition,
  addWidgetTile,
  destroyAllTiles,
  remountWidgetTiles,
  removeWidgetTile,
  resizeWidgetTile,
} from './grid-dashboard-setup.js';
import {getNextInstanceId} from './widget-counter.js';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function widgetPlugin(
  name: string,
  createInstance: (container: HTMLElement) => PluginInstance | Promise<PluginInstance>,
): LoadedPlugin {
  const entry: WidgetListEntry = {
    name,
    version: '1.0.0',
    label: name.toUpperCase(),
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3, minW: 2, minH: 2},
  };

  return {entry, module: {createInstance: (container) => createInstance(container)}};
}

function pagePlugin(name: string): LoadedPlugin {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    backend: emptyBackend,
    type: 'page',
    route: `/${name}`,
  };

  return {entry, module: {createInstance: () => ({unmount: vi.fn()})}};
}

interface FakeGrid {
  grid: GridStack;
  added: GridStackWidget[];
  addWidget: ReturnType<typeof vi.fn>;
  removeWidget: ReturnType<typeof vi.fn>;
}

function createFakeGrid(withContent = true): FakeGrid {
  const added: GridStackWidget[] = [];

  const addWidget = vi.fn((opts: GridStackWidget) => {
    added.push(opts);

    const el = document.createElement('div');

    el.className = 'grid-stack-item';

    if (withContent) {
      const content = document.createElement('div');

      content.className = 'grid-stack-item-content';
      el.appendChild(content);
    }

    document.body.appendChild(el);

    return el;
  });
  const removeWidget = vi.fn();

  return {grid: {addWidget, removeWidget, prepareDragDrop: vi.fn()} as unknown as GridStack, added, addWidget,
    removeWidget};
}

function noop(): PluginInstance {
  return {unmount: vi.fn()};
}

/** Adds a tile and asserts a non-null id, narrowing it for follow-up operations. */
function addTile(grid: GridStack, name: string, position?: RestoredTilePosition): string {
  const id = addWidgetTile(grid, name, position);

  if (id === null) {
    throw new Error(`addWidgetTile("${name}") unexpectedly returned null`);
  }

  return id;
}

describe('grid-dashboard-setup', () => {
  beforeEach(() => {
    vi.mocked(getNextInstanceId).mockImplementation((name: string) => `${name}:1`);
    vi.mocked(unmountPlugin).mockClear();
  });

  afterEach(() => {
    destroyAllTiles();
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('ignores an unknown plugin', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);

    const {grid, addWidget} = createFakeGrid();

    expect(addWidgetTile(grid, 'missing')).toBeNull();
    expect(addWidget).not.toHaveBeenCalled();
  });

  it('ignores a page plugin', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(pagePlugin('settings-plugin'));

    const {grid, addWidget} = createFakeGrid();

    expect(addWidgetTile(grid, 'settings-plugin')).toBeNull();
    expect(addWidget).not.toHaveBeenCalled();
  });

  it('adds a new widget with auto-position and direct entry size', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const {grid, added} = createFakeGrid();
    const id = addWidgetTile(grid, 'traffic');

    expect(id).toBe('widget-traffic:1');
    expect(added[0]).toEqual({
      id: 'widget-traffic:1',
      x: undefined,
      y: undefined,
      w: 4,
      h: 3,
      minW: 2,
      minH: 2,
    });
  });

  it('restores position but keeps current minimums authoritative', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const {grid, added} = createFakeGrid();
    const id = addWidgetTile(grid, 'traffic', {x: 1, y: 2, w: 6, h: 5, instanceId: 'traffic:9'});

    expect(id).toBe('widget-traffic:9');
    expect(added[0]).toEqual({
      id: 'widget-traffic:9',
      x: 1,
      y: 2,
      w: 6,
      h: 5,
      minW: 2,
      minH: 2,
    });
  });

  it('builds a host frame with label title, plugin body, and accessible remove button', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(
      widgetPlugin('traffic', (container) => {
        container.textContent = 'live widget';

        return noop();
      }),
    );

    const {grid} = createFakeGrid();

    addWidgetTile(grid, 'traffic');

    const content = document.querySelector('.grid-stack-item-content');
    const title = content?.querySelector('.mndw-grid-tile__title');
    const body = content?.querySelector('.mndw-grid-tile__body');
    const remove = content?.querySelector<HTMLButtonElement>('.mndw-grid-tile__close');

    expect(title?.textContent).toBe('TRAFFIC');
    expect(body?.textContent).toBe('live widget');
    expect(remove?.getAttribute('aria-label')).toBe('Remove TRAFFIC');
  });

  it('contains a synchronous createInstance failure to the plugin body', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(
      widgetPlugin('traffic', () => {
        throw new Error('boom');
      }),
    );

    const {grid} = createFakeGrid();

    addWidgetTile(grid, 'traffic');

    const content = document.querySelector('.grid-stack-item-content');

    expect(content?.querySelector('.mndw-grid-tile__body')?.textContent).toBe('Error loading widget');
    expect(content?.querySelector('.mndw-grid-tile__title')?.textContent).toBe('TRAFFIC');
    expect(content?.querySelector('.mndw-grid-tile__close')).not.toBeNull();
  });

  it('contains an asynchronous createInstance failure to the plugin body', async () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(
      widgetPlugin('traffic', () => Promise.reject(new Error('boom'))),
    );

    const {grid} = createFakeGrid();

    addWidgetTile(grid, 'traffic');
    await Promise.resolve();
    await Promise.resolve();

    const content = document.querySelector('.grid-stack-item-content');

    expect(content?.querySelector('.mndw-grid-tile__body')?.textContent).toBe('Error loading widget');
    expect(content?.querySelector('.mndw-grid-tile__title')?.textContent).toBe('TRAFFIC');
  });

  it('removes a tile clearing only its instance storage', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const {grid} = createFakeGrid();
    const id = addTile(grid, 'traffic');

    removeWidgetTile(id);

    expect(unmountPlugin).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      clearStorage: true,
      closeReason: 'plugin-unmount',
    });
  });

  it('tears down all tiles preserving instance storage on host navigation', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const {grid} = createFakeGrid();

    addWidgetTile(grid, 'traffic');
    destroyAllTiles('host-navigation');

    expect(unmountPlugin).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      clearStorage: false,
      closeReason: 'host-navigation',
    });
  });

  it('forwards resize dimensions to the instance and catches a thrown callback', () => {
    const onResize = vi.fn();

    vi.mocked(pluginRegistry).get.mockReturnValue(
      widgetPlugin('traffic', () => ({unmount: vi.fn(), onResize})),
    );

    const {grid} = createFakeGrid();
    const id = addTile(grid, 'traffic');

    resizeWidgetTile(id, {w: 6, h: 4});

    expect(onResize).toHaveBeenCalledWith({w: 6, h: 4});

    onResize.mockImplementation(() => {
      throw new Error('resize failed');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resizeWidgetTile(id, {w: 5, h: 3})).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('registers multiple instances of one plugin independently', () => {
    const first = vi.fn();
    const second = vi.fn();

    vi.mocked(getNextInstanceId)
      .mockReturnValueOnce('traffic:1')
      .mockReturnValueOnce('traffic:2');
    vi.mocked(pluginRegistry).get
      .mockReturnValueOnce(widgetPlugin('traffic', () => ({unmount: vi.fn(), onResize: first})))
      .mockReturnValueOnce(widgetPlugin('traffic', () => ({unmount: vi.fn(), onResize: second})));

    const {grid} = createFakeGrid();
    const id1 = addTile(grid, 'traffic');
    const id2 = addTile(grid, 'traffic');

    expect(id1).toBe('widget-traffic:1');
    expect(id2).toBe('widget-traffic:2');

    resizeWidgetTile(id1, {w: 6, h: 4});

    expect(first).toHaveBeenCalledWith({w: 6, h: 4});
    expect(second).not.toHaveBeenCalled();
  });

  describe('remountWidgetTiles', () => {
    function labelledWidget(name: string, text: string): LoadedPlugin {
      const plugin = widgetPlugin(name, (container) => {
        container.textContent = text;

        return noop();
      });

      return plugin;
    }

    it('is a no-op returning true when no tile matches the plugin', async () => {
      const next = labelledWidget('absent', 'x');

      expect(await remountWidgetTiles('absent', next, next)).toBe(true);
    });

    it('remounts matching tiles in place with the candidate module, preserving instance storage', async () => {
      vi.mocked(pluginRegistry).get.mockReturnValue(labelledWidget('traffic', 'v1'));

      const {grid} = createFakeGrid();
      const id = addTile(grid, 'traffic');
      const body = () => document.querySelector('.mndw-grid-tile__body');

      expect(body()?.textContent).toBe('v1');
      vi.mocked(unmountPlugin).mockClear();

      const ok = await remountWidgetTiles(
        'traffic',
        labelledWidget('traffic', 'v2'),
        labelledWidget('traffic', 'v1'),
      );

      expect(ok).toBe(true);
      expect(body()?.textContent).toBe('v2');
      // The tile keeps its instance id and its storage is preserved across the reload.
      expect(id).toBe('widget-traffic:1');
      expect(unmountPlugin).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        clearStorage: false,
        closeReason: 'host-navigation',
      });
    });

    it('rolls back to the prior module when a candidate createInstance fails', async () => {
      vi.mocked(pluginRegistry).get.mockReturnValue(labelledWidget('traffic', 'v1'));

      const {grid} = createFakeGrid();

      addTile(grid, 'traffic');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = widgetPlugin('traffic', () => {
        throw new Error('boom');
      });

      const ok = await remountWidgetTiles('traffic', failing, labelledWidget('traffic', 'restored'));

      expect(ok).toBe(false);
      expect(document.querySelector('.mndw-grid-tile__body')?.textContent).toBe('restored');

      errorSpy.mockRestore();
    });
  });

  it('rolls back a tile GridStack created without a content element', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const {grid, removeWidget} = createFakeGrid(false);
    const id = addWidgetTile(grid, 'traffic');

    expect(id).toBeNull();
    expect(removeWidget).toHaveBeenCalledWith(expect.anything(), true);
  });
});
