/* eslint id-blacklist: 0 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

type Handler = (...args: unknown[]) => void;

const order: string[] = [];
const handlers = new Map<string, Handler>();
const offEvents: string[] = [];
const save = vi.fn();
const update = vi.fn();
const resizeToContent = vi.fn();
const destroy = vi.fn();
let initOptions: unknown;

const fakeGrid = {
  on: vi.fn((event: string, handler: Handler) => {
    handlers.set(event, handler);
    order.push(`on:${event}`);
  }),
  off: vi.fn((event: string) => {
    offEvents.push(event);
  }),
  save,
  update,
  resizeToContent,
  destroy,
};

vi.mock('gridstack', () => ({
  GridStack: {
    init: vi.fn((options: unknown) => {
      initOptions = options;
      order.push('init');

      return fakeGrid;
    }),
  },
}));

import DashboardGrid from './DashboardGrid.svelte';

interface MountResult {
  component: ReturnType<typeof mount>;
  target: HTMLElement;
  onGridReady: ReturnType<typeof vi.fn>;
  onGridDestroyed: ReturnType<typeof vi.fn>;
  onWidgetRemoved: ReturnType<typeof vi.fn>;
  onLayoutChanged: ReturnType<typeof vi.fn>;
  onWidgetResized: ReturnType<typeof vi.fn>;
}

function mountGrid(): MountResult {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const props = {
    onGridReady: vi.fn(() => order.push('ready')),
    onGridDestroyed: vi.fn(),
    onWidgetRemoved: vi.fn(),
    onLayoutChanged: vi.fn(),
    onWidgetResized: vi.fn(),
  };

  const component = mount(DashboardGrid, {target, props});

  flushSync();

  return {component, target, ...props};
}

function createResizeItem(id = 'widget-a:1', w = 4, h = 3): {
  item: HTMLElement;
  node: {id: string; w: number; h: number};
} {
  const item = document.createElement('div');
  const node = {id, w, h};

  Object.assign(item, {gridstackNode: node});

  return {item, node};
}

describe('DashboardGrid', () => {
  beforeEach(() => {
    order.length = 0;
    offEvents.length = 0;
    handlers.clear();
    save.mockReset();
    update.mockReset();
    resizeToContent.mockReset();
    destroy.mockReset();
    initOptions = undefined;
    fakeGrid.on.mockClear();
    fakeGrid.off.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers every listener before signalling grid ready', () => {
    const {component, target} = mountGrid();

    expect(order).toEqual([
      'init',
      'on:removed',
      'on:added',
      'on:change',
      'on:resizestart',
      'on:resize',
      'on:resizestop',
      'ready',
    ]);

    void unmount(component);
    target.remove();
  });

  it('restricts tile dragging to the title bar handle', () => {
    const {component, target} = mountGrid();

    expect(initOptions).toEqual(expect.objectContaining({
      draggable: {handle: '.mndw-grid-tile__title'},
    }));

    void unmount(component);
    target.remove();
  });

  it('keeps GridStack at its desktop base column count', () => {
    const {component, target} = mountGrid();

    expect(initOptions).toEqual(expect.objectContaining({column: 12}));
    expect(initOptions).not.toHaveProperty('columnOpts');

    void unmount(component);
    target.remove();
  });

  it('unregisters listeners on cleanup', () => {
    const {component, target, onGridDestroyed} = mountGrid();

    void unmount(component);

    expect(offEvents).toEqual(expect.arrayContaining([
      'removed',
      'added',
      'change',
      'resizestart',
      'resize',
      'resizestop',
    ]));
    expect(destroy).toHaveBeenCalledWith(false);
    expect(onGridDestroyed).toHaveBeenCalledTimes(1);

    target.remove();
  });

  it('forwards removed widget ids, ignoring nodes without a string id', () => {
    const {component, target, onWidgetRemoved} = mountGrid();

    handlers.get('removed')?.(new Event('removed'), [{id: 'widget-a:1'}, {id: undefined}]);

    expect(onWidgetRemoved).toHaveBeenCalledTimes(1);
    expect(onWidgetRemoved).toHaveBeenCalledWith('widget-a:1');

    void unmount(component);
    target.remove();
  });

  it('projects complete valid tiles from a save() array on change', () => {
    const {component, target, onLayoutChanged} = mountGrid();

    save.mockReturnValue([
      {id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3, extra: 'ignored'},
      {id: 'widget-b:1', x: 2, y: 1},
    ]);

    handlers.get('change')?.(new Event('change'));

    expect(onLayoutChanged).toHaveBeenCalledWith([{id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3}]);

    void unmount(component);
    target.remove();
  });

  it('projects complete valid tiles from a save() array on added', () => {
    const {component, target, onLayoutChanged} = mountGrid();

    save.mockReturnValue([
      {id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3, extra: 'ignored'},
      {id: 'widget-b:1', x: 2, y: 1},
    ]);

    handlers.get('added')?.(new Event('added'));

    expect(save).toHaveBeenCalledWith(false);
    expect(onLayoutChanged).toHaveBeenCalledWith([{id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3}]);

    void unmount(component);
    target.remove();
  });

  it('emits an empty layout when save() returns GridStackOptions rather than an array', () => {
    const {component, target, onLayoutChanged} = mountGrid();

    save.mockReturnValue({column: 12, children: []});

    handlers.get('change')?.(new Event('change'));

    expect(onLayoutChanged).toHaveBeenCalledWith([]);

    void unmount(component);
    target.remove();
  });

  it('forwards integer resize dimensions from the resized node', () => {
    const {component, target, onWidgetResized} = mountGrid();
    const {item} = createResizeItem('widget-a:1', 6, 4);

    handlers.get('resizestop')?.(new Event('resizestop'), item);

    expect(onWidgetResized).toHaveBeenCalledWith('widget-a:1', {w: 6, h: 4});

    void unmount(component);
    target.remove();
  });

  it('ignores resize events with missing or non-integer node data', () => {
    const {component, target, onWidgetResized} = mountGrid();
    const missingNodeItem = document.createElement('div');
    const nonIntegerItem = createResizeItem('widget-a:1', 6.5, 4).item;

    Object.assign(missingNodeItem, {gridstackNode: undefined});

    handlers.get('resizestop')?.(new Event('resizestop'), missingNodeItem);
    handlers.get('resizestop')?.(new Event('resizestop'), nonIntegerItem);

    expect(onWidgetResized).not.toHaveBeenCalled();

    void unmount(component);
    target.remove();
  });

  it('shows and updates the current grid dimensions while resizing', () => {
    const {component, target} = mountGrid();
    const {item, node} = createResizeItem();

    handlers.get('resizestart')?.(new Event('resizestart'), item);

    expect(item.querySelector('.mndw-grid-resize-indicator')?.textContent).toBe('4 × 3');

    node.w = 6;
    node.h = 4;
    handlers.get('resize')?.(new Event('resize'), item);

    expect(item.querySelector('.mndw-grid-resize-indicator')?.textContent).toBe('6 × 4');

    void unmount(component);
    target.remove();
  });

  it('removes the indicator on resize stop and forwards final dimensions', () => {
    const {component, target, onWidgetResized} = mountGrid();
    const {item, node} = createResizeItem();

    handlers.get('resizestart')?.(new Event('resizestart'), item);
    node.w = 7;
    node.h = 5;
    handlers.get('resizestop')?.(new Event('resizestop'), item);

    expect(item.querySelector('.mndw-grid-resize-indicator')).toBeNull();
    expect(onWidgetResized).toHaveBeenCalledWith('widget-a:1', {w: 7, h: 5});

    void unmount(component);
    target.remove();
  });

  it('ignores resize-preview events without valid integer dimensions', () => {
    const {component, target} = mountGrid();
    const item = document.createElement('div');

    Object.assign(item, {gridstackNode: {id: 'widget-a:1', w: 6.5, h: 4}});

    handlers.get('resizestart')?.(new Event('resizestart'), item);
    handlers.get('resize')?.(new Event('resize'), item);

    expect(item.querySelector('.mndw-grid-resize-indicator')).toBeNull();

    void unmount(component);
    target.remove();
  });
});
