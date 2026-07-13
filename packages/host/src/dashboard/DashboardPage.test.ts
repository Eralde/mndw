/* eslint id-blacklist: 0 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

type Handler = (...args: unknown[]) => void;

const gridHandlers = new Map<string, Handler>();
const teardownLog: string[] = [];
const save = vi.fn(() => [] as unknown);
const destroy = vi.fn(() => teardownLog.push('destroy'));

const fakeGrid = {
  on: vi.fn((event: string, handler: Handler) => gridHandlers.set(event, handler)),
  off: vi.fn(),
  save,
  destroy,
};

vi.mock('gridstack', () => ({
  GridStack: {init: vi.fn(() => fakeGrid)},
}));

vi.mock('./grid-dashboard-setup.js', () => ({
  addWidgetTile: vi.fn(() => 'widget-x:1'),
  removeWidgetTile: vi.fn(),
  resizeWidgetTile: vi.fn(),
  destroyAllTiles: vi.fn(() => teardownLog.push('destroyAll')),
}));

vi.mock('./grid-layout-persistence.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./grid-layout-persistence.js')>(),
  loadGridLayout: vi.fn(() => null),
  saveGridLayout: vi.fn(),
}));

vi.mock('./widget-counter.js', () => ({
  raiseInstanceCounter: vi.fn(),
}));

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {get: vi.fn(), getWidgets: vi.fn(() => [])},
}));

import {addWidgetTile, destroyAllTiles, resizeWidgetTile} from './grid-dashboard-setup.js';
import {loadGridLayout, saveGridLayout} from './grid-layout-persistence.js';
import {pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {raiseInstanceCounter} from './widget-counter.js';
import DashboardPage from './DashboardPage.svelte';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function widgetEntry(name: string): WidgetListEntry {
  return {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3},
  };
}

function mountPage(): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(DashboardPage, {target});

  flushSync();

  return {component, target};
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gridHandlers.clear();
    teardownLog.length = 0;
    save.mockReturnValue([]);
    vi.mocked(loadGridLayout).mockReturnValue(null);
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([]);
    vi.mocked(addWidgetTile).mockReturnValue('widget-x:1');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('restores persisted tiles and raises the counter to the highest suffix', () => {
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => ({
      entry: widgetEntry(name),
      module: {createInstance: vi.fn()},
    }));
    vi.mocked(loadGridLayout).mockReturnValue([
      {id: 'widget-traffic:2', x: 0, y: 0, w: 4, h: 3},
      {id: 'widget-traffic:5', x: 4, y: 0, w: 4, h: 3},
    ]);

    const {component, target} = mountPage();

    expect(addWidgetTile).toHaveBeenNthCalledWith(1, fakeGrid, 'traffic', {
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      instanceId: 'traffic:2',
    });
    expect(addWidgetTile).toHaveBeenNthCalledWith(2, fakeGrid, 'traffic', {
      x: 4,
      y: 0,
      w: 4,
      h: 3,
      instanceId: 'traffic:5',
    });
    expect(raiseInstanceCounter).toHaveBeenCalledWith('traffic', 5);
    // Restoration must not eagerly persist the normalized layout.
    expect(saveGridLayout).not.toHaveBeenCalled();

    void unmount(component);
    target.remove();
  });

  it('suppresses persistence for change events fired during restoration', () => {
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => ({
      entry: widgetEntry(name),
      module: {createInstance: vi.fn()},
    }));
    // addWidgetTile fires a layout change synchronously mid-restore.
    vi.mocked(addWidgetTile).mockImplementation(() => {
      gridHandlers.get('change')?.(new Event('change'));

      return 'widget-traffic:1';
    });
    vi.mocked(loadGridLayout).mockReturnValue([{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}]);

    const {component, target} = mountPage();

    vi.advanceTimersByTime(500);

    expect(saveGridLayout).not.toHaveBeenCalled();

    void unmount(component);
    target.remove();
  });

  it('resets the restoring flag after a failed tile addition', () => {
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => ({
      entry: widgetEntry(name),
      module: {createInstance: vi.fn()},
    }));
    vi.mocked(addWidgetTile).mockImplementation(() => {
      throw new Error('add failed');
    });
    vi.mocked(loadGridLayout).mockReturnValue([{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}]);

    let component: ReturnType<typeof mount> | undefined;
    const target = document.createElement('div');

    document.body.appendChild(target);

    expect(() => {
      component = mount(DashboardPage, {target});
      flushSync();
    }).toThrow('add failed');

    // A later user change must persist — restoring was cleared by the finally block.
    save.mockReturnValue([{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}]);
    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);

    expect(saveGridLayout).toHaveBeenCalledWith([{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}]);

    if (component) {
      void unmount(component);
    }

    target.remove();
  });

  it('debounces persistence and replaces a pending timer', () => {
    const {component, target} = mountPage();

    save.mockReturnValue([{id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3}]);

    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(300);
    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(300);

    // First timer was replaced, so nothing has persisted yet at 600 ms elapsed.
    expect(saveGridLayout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(saveGridLayout).toHaveBeenCalledTimes(1);

    void unmount(component);
    target.remove();
  });

  it('forwards resize events to the tile registry', () => {
    const {component, target} = mountPage();

    gridHandlers.get('resizestop')?.(new Event('resizestop'), {
      gridstackNode: {id: 'widget-a:1', w: 6, h: 4},
    });

    expect(resizeWidgetTile).toHaveBeenCalledWith('widget-a:1', {w: 6, h: 4});

    void unmount(component);
    target.remove();
  });

  it('tears down in order: clear timer, destroy tiles, destroy grid', () => {
    const {component, target} = mountPage();

    // Leave a debounce timer pending to prove it is cleared before it can fire.
    save.mockReturnValue([{id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3}]);
    gridHandlers.get('change')?.(new Event('change'));

    void unmount(component);
    flushSync();

    expect(teardownLog).toEqual(['destroyAll', 'destroy']);
    expect(destroyAllTiles).toHaveBeenCalledWith('host-navigation');
    expect(destroy).toHaveBeenCalledWith(false);

    vi.advanceTimersByTime(500);
    expect(saveGridLayout).not.toHaveBeenCalled();

    target.remove();
  });

  it('adds a widget and closes the picker on add', () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([{
      entry: widgetEntry('traffic'),
      module: {createInstance: vi.fn()},
    }]);

    const {component, target} = mountPage();

    const addButton = [...target.querySelectorAll('button')].find(
      (btn) => btn.textContent?.includes('Add Widget'),
    );

    addButton?.click();
    flushSync();

    const pickerButton = [...document.querySelectorAll('.mndw-floating-panel button')].find(
      (btn) => btn.textContent?.trim() === 'traffic',
    ) as HTMLButtonElement | undefined;

    pickerButton?.click();
    flushSync();

    expect(addWidgetTile).toHaveBeenCalledWith(fakeGrid, 'traffic');
    expect(document.querySelector('.mndw-floating-panel')).toBeNull();

    void unmount(component);
    target.remove();
  });
});
