/* eslint id-blacklist: 0 */
import type {GridStack, GridStackWidget} from 'gridstack';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const controllers = new Map<string, {
  id: string;
  frame: HTMLElement;
  handle: {getMounted: ReturnType<typeof vi.fn>};
  pluginName: string;
}>();

const ensureTileController = vi.hoisted(() => vi.fn());
const getTileController = vi.hoisted(() => vi.fn());

vi.mock('./tile-controller.js', () => ({ensureTileController, getTileController}));

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {get: vi.fn()},
}));

vi.mock('./widget-counter.js', () => ({
  getNextInstanceId: vi.fn(),
}));

import type {PluginInstance} from '@mndw/sdk';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {PageListEntry, WidgetListEntry} from '../runtime/plugin-types.js';
import {getNextInstanceId} from './widget-counter.js';
import {type RestoredTilePosition, addWidgetTile, resizeWidgetTile} from './grid-dashboard-setup.js';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function widgetPlugin(name: string): LoadedPlugin {
  const entry: WidgetListEntry = {
    name,
    version: '1.0.0',
    label: name.toUpperCase(),
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3, minW: 2, minH: 2},
  };

  return {entry, module: {createInstance: () => ({unmount: vi.fn()})}};
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
    depsStatus: 'ready',
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
  prepareDragDrop: ReturnType<typeof vi.fn>;
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
  const prepareDragDrop = vi.fn();

  return {
    grid: {addWidget, removeWidget, prepareDragDrop} as unknown as GridStack,
    added,
    addWidget,
    removeWidget,
    prepareDragDrop,
  };
}

function createController(pluginName: string, instance?: PluginInstance): {
  id: string;
  frame: HTMLElement;
  handle: {getMounted: ReturnType<typeof vi.fn>};
  pluginName: string;
} {
  const id = `widget-${pluginName}:1`;
  const frame = document.createElement('div');
  const handle = {getMounted: vi.fn(() => instance === undefined ? null : {instance})};
  const controller = {id, frame, handle, pluginName};

  controllers.set(id, controller);

  return controller;
}

describe('grid-dashboard-setup', () => {
  beforeEach(() => {
    controllers.clear();
    vi.mocked(pluginRegistry).get.mockReset();
    vi.mocked(getNextInstanceId).mockReset();
    vi.mocked(getNextInstanceId).mockReturnValue('traffic:1');
    ensureTileController.mockReset();
    ensureTileController.mockImplementation((pluginName: string) => {
      return controllers.get(`widget-${pluginName}:1`) ?? createController(pluginName);
    });
    getTileController.mockReset();
    getTileController.mockImplementation((id: string) => controllers.get(id));
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('ignores an unknown plugin', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);

    const {grid, addWidget} = createFakeGrid();

    expect(addWidgetTile(grid, 'missing', vi.fn())).toBeNull();
    expect(addWidget).not.toHaveBeenCalled();
  });

  it('ignores a page plugin', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(pagePlugin('settings-plugin'));

    const {grid, addWidget} = createFakeGrid();

    expect(addWidgetTile(grid, 'settings-plugin', vi.fn())).toBeNull();
    expect(addWidget).not.toHaveBeenCalled();
  });

  it('forwards geometry, attaches the shared frame, and reinitializes drag handling', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic'));

    const {grid, added, prepareDragDrop} = createFakeGrid();
    const controller = createController('traffic');

    ensureTileController.mockReturnValue(controller);

    const id = addWidgetTile(grid, 'traffic', vi.fn(), {
      x: 1,
      y: 2,
      w: 6,
      h: 5,
      instanceId: 'traffic:9',
    });

    expect(id).toBe('widget-traffic:1');
    expect(added[0]).toEqual({
      id: 'widget-traffic:1',
      x: 1,
      y: 2,
      w: 6,
      h: 5,
      minW: 2,
      minH: 2,
    });
    expect(document.querySelector('.grid-stack-item-content')?.contains(controller.frame)).toBe(true);
    expect(prepareDragDrop).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('uses manifest defaults and allocates a new instance for a new tile', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic'));

    const {grid, added} = createFakeGrid();

    ensureTileController.mockReturnValue(createController('traffic'));

    expect(addWidgetTile(grid, 'traffic', vi.fn())).toBe('widget-traffic:1');
    expect(added[0]).toEqual({
      id: 'widget-traffic:1',
      x: undefined,
      y: undefined,
      w: 4,
      h: 3,
      minW: 2,
      minH: 2,
    });
    expect(getNextInstanceId).toHaveBeenCalledWith('traffic');
  });

  it('returns null and rolls back when GridStack has no content element', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic'));

    const {grid, removeWidget} = createFakeGrid(false);

    ensureTileController.mockReturnValue(createController('traffic'));

    expect(addWidgetTile(grid, 'traffic', vi.fn())).toBeNull();
    expect(removeWidget).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('reuses an existing controller when restoring a tile', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic'));

    const {grid} = createFakeGrid();
    const controller = createController('traffic');

    ensureTileController.mockReturnValue(controller);

    const position: RestoredTilePosition = {x: 1, y: 2, w: 4, h: 3, instanceId: 'traffic:1'};

    addWidgetTile(grid, 'traffic', vi.fn(), position);
    addWidgetTile(grid, 'traffic', vi.fn(), position);

    expect(ensureTileController).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('.grid-stack-item-content')).toHaveLength(2);
    expect(document.querySelectorAll('.grid-stack-item-content')[1]?.contains(controller.frame)).toBe(true);
  });

  it('forwards resize dimensions and isolates a throwing onResize callback', () => {
    const onResize = vi.fn();
    const instance = {unmount: vi.fn(), onResize};

    getTileController.mockReturnValue(createController('traffic', instance));

    resizeWidgetTile('widget-traffic:1', {w: 6, h: 4});

    expect(onResize).toHaveBeenCalledWith({w: 6, h: 4});

    onResize.mockImplementation(() => {
      throw new Error('resize failed');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resizeWidgetTile('widget-traffic:1', {w: 5, h: 3})).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
