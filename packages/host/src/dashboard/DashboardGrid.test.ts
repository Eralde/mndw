import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

type Handler = (...args: unknown[]) => void;

const order: string[] = [];
const handlers = new Map<string, Handler>();
const offEvents: string[] = [];
const save = vi.fn();

const fakeGrid = {
  on: vi.fn((event: string, handler: Handler) => {
    handlers.set(event, handler);
    order.push(`on:${event}`);
  }),
  off: vi.fn((event: string) => {
    offEvents.push(event);
  }),
  save,
};

vi.mock('gridstack', () => ({
  GridStack: {
    init: vi.fn(() => {
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
  onWidgetRemoved: ReturnType<typeof vi.fn>;
  onLayoutChanged: ReturnType<typeof vi.fn>;
  onWidgetResized: ReturnType<typeof vi.fn>;
}

function mountGrid(): MountResult {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const props = {
    onGridReady: vi.fn(() => order.push('ready')),
    onWidgetRemoved: vi.fn(),
    onLayoutChanged: vi.fn(),
    onWidgetResized: vi.fn(),
  };

  const component = mount(DashboardGrid, {target, props});

  flushSync();

  return {component, target, ...props};
}

describe('DashboardGrid', () => {
  beforeEach(() => {
    order.length = 0;
    offEvents.length = 0;
    handlers.clear();
    save.mockReset();
    fakeGrid.on.mockClear();
    fakeGrid.off.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('registers every listener before signalling grid ready', () => {
    const {component, target} = mountGrid();

    expect(order).toEqual(['init', 'on:removed', 'on:added', 'on:change', 'on:resizestop', 'ready']);

    void unmount(component);
    target.remove();
  });

  it('unregisters listeners on cleanup', () => {
    const {component, target} = mountGrid();

    void unmount(component);

    expect(offEvents).toEqual(expect.arrayContaining(['removed', 'added', 'change', 'resizestop']));

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
      {id: 'widget-b:1', x: 2, y: 1}, // incomplete → dropped
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
      {id: 'widget-b:1', x: 2, y: 1}, // incomplete → dropped
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

    handlers.get('resizestop')?.(new Event('resizestop'), {
      gridstackNode: {id: 'widget-a:1', w: 6, h: 4},
    });

    expect(onWidgetResized).toHaveBeenCalledWith('widget-a:1', {w: 6, h: 4});

    void unmount(component);
    target.remove();
  });

  it('ignores resize events with missing or non-integer node data', () => {
    const {component, target, onWidgetResized} = mountGrid();

    handlers.get('resizestop')?.(new Event('resizestop'), {gridstackNode: undefined});
    handlers.get('resizestop')?.(new Event('resizestop'), {
      gridstackNode: {id: 'widget-a:1', w: 6.5, h: 4},
    });

    expect(onWidgetResized).not.toHaveBeenCalled();

    void unmount(component);
    target.remove();
  });
});
