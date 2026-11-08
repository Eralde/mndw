// @vitest-environment happy-dom
/* eslint id-blacklist: 0 */
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';

type Handler = (...args: unknown[]) => void;

const mobileState = vi.hoisted(() => {
  const state: {
    matches: boolean;
    listener: ((event: MediaQueryListEvent) => void) | undefined;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  } = {
    matches: false,
    listener: undefined,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  state.addEventListener.mockImplementation((_event: string, listener: (event: MediaQueryListEvent) => void) => {
    state.listener = listener;
  });
  state.removeEventListener.mockImplementation(() => {
    state.listener = undefined;
  });

  return state;
});

const removeCallbacks = vi.hoisted(() => new Map<string, (tileId: string) => void>());
const mobileFrames = vi.hoisted(() => new Map<string, HTMLElement>());
const currentTitles = vi.hoisted(() => new Map<string, string>());

const gridHandlers = new Map<string, Handler>();
const teardownLog: string[] = [];
const save = vi.fn(() => [] as unknown);
const destroy = vi.fn(() => teardownLog.push('destroy'));
const getColumn = vi.fn(() => 12);
const getGridItems = vi.fn(() => []);

const fakeGrid = {
  on: vi.fn((event: string, handler: Handler) => gridHandlers.set(event, handler)),
  off: vi.fn(),
  save,
  destroy,
  getColumn,
  getGridItems,
};

vi.mock('gridstack', () => ({
  GridStack: {init: vi.fn(() => fakeGrid)},
}));

vi.mock('./grid-dashboard-setup.js', () => ({
  addWidgetTile: vi.fn(() => 'widget-x:1'),
  resizeWidgetTile: vi.fn(),
}));

vi.mock('./tile-controller.js', () => ({
  removeTileController: vi.fn(),
  getTileController: vi.fn((id: string) => ({
    getTileTitle: () => currentTitles.get(id) ?? '',
  })),
  ensureTileController: vi.fn((
    _services: unknown,
    _registry: unknown,
    _pluginName: string,
    instanceId: string,
    onRemoveRequest: (tileId: string) => void,
  ) => {
    const id = `widget-${instanceId}`;
    let frame = mobileFrames.get(id);

    if (frame === undefined) {
      frame = document.createElement('div');
      mobileFrames.set(id, frame);
    }

    removeCallbacks.set(id, onRemoveRequest);

    return {id, frame};
  }),
  hydratePendingTiles: vi.fn(),
  destroyAllTiles: vi.fn(() => teardownLog.push('destroyAll')),
}));

vi.mock('../layout/breakpoint.js', () => ({
  mobileMediaQuery: vi.fn(() => mobileState),
}));

vi.mock('./grid-layout-persistence.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./grid-layout-persistence.js')>(),
  loadDashboardLayout: vi.fn(() => null),
  saveDashboardLayout: vi.fn(),
}));

vi.mock('./widget-counter.js', () => ({
  getNextInstanceId: vi.fn((name: string) => `${name}:1`),
  raiseInstanceCounter: vi.fn(),
}));

vi.mock('../runtime/plugin-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/plugin-registry.js')>(),
  pluginRegistry: {get: vi.fn(), getWidgets: vi.fn(() => [])},
}));

import {addWidgetTile, resizeWidgetTile} from './grid-dashboard-setup.js';
import {destroyAllTiles, ensureTileController, removeTileController} from './tile-controller.js';
import {loadDashboardLayout, saveDashboardLayout} from './grid-layout-persistence.js';
import {pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {raiseInstanceCounter} from './widget-counter.js';
import DashboardPage from './DashboardPage.svelte';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';

const emptyBackend = {routes: {}};

function widgetEntry(name: string): WidgetListEntry {
  return {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3},
  };
}

function configureTwoClockWidgets(): void {
  vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
    {entry: widgetEntry('clock'), module: {createInstance: vi.fn()}},
  ]);
  vi.mocked(loadDashboardLayout).mockReturnValue({
    tiles: [
      {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1},
      {id: 'widget-clock:2', x: 2, y: 0, w: 2, h: 1},
    ],
    mobileOrder: ['widget-clock:1', 'widget-clock:2'],
  });
}

function arrangeButton(target: HTMLElement): HTMLElement | undefined {
  return [...target.querySelectorAll<HTMLElement>('.mndw-dashboard__toolbar mndw-button')]
    .find((button) => button.textContent?.includes('Arrange widgets'));
}

function mountPage(): {component: ReturnType<typeof mount>; target: HTMLElement} {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(DashboardPage, {
    target,
    context: createHostServicesContext({...createHostServices(), registry: pluginRegistry}),
  });

  flushSync();

  return {component, target};
}

describe('DashboardPage', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mobileState.matches = false;
    mobileState.listener = undefined;
    mobileState.addEventListener.mockClear();
    mobileState.removeEventListener.mockClear();
    removeCallbacks.clear();
    mobileFrames.clear();
    currentTitles.clear();
    gridHandlers.clear();
    teardownLog.length = 0;
    save.mockReturnValue([]);
    destroy.mockClear();
    vi.mocked(loadDashboardLayout).mockReturnValue(null);
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([]);
    vi.mocked(addWidgetTile).mockReturnValue('widget-x:1');
    vi.mocked(ensureTileController).mockClear();
    vi.mocked(removeTileController).mockClear();
    getGridItems.mockReset();
    getGridItems.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('restores persisted tiles and raises the counter to the highest suffix', () => {
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => ({
      entry: widgetEntry(name),
      module: {createInstance: vi.fn()},
    }));
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [
        {id: 'widget-traffic:2', x: 0, y: 0, w: 4, h: 3},
        {id: 'widget-traffic:5', x: 4, y: 0, w: 4, h: 3},
      ],
      mobileOrder: ['widget-traffic:2', 'widget-traffic:5'],
    });

    const {component, target} = mountPage();

    expect(addWidgetTile).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      pluginRegistry,
      fakeGrid,
      'traffic',
      expect.any(Function),
      {
        x: 0,
        y: 0,
        w: 4,
        h: 3,
        instanceId: 'traffic:2',
      },
    );
    expect(addWidgetTile).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      pluginRegistry,
      fakeGrid,
      'traffic',
      expect.any(Function),
      {
        x: 4,
        y: 0,
        w: 4,
        h: 3,
        instanceId: 'traffic:5',
      },
    );
    expect(raiseInstanceCounter).toHaveBeenCalledWith('traffic', 5);
    // Restoration must not eagerly persist the normalized layout.
    expect(saveDashboardLayout).not.toHaveBeenCalled();

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
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-traffic:1'],
    });

    const {component, target} = mountPage();

    vi.advanceTimersByTime(500);

    expect(saveDashboardLayout).not.toHaveBeenCalled();

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
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-traffic:1'],
    });

    let component: ReturnType<typeof mount> | undefined;
    const target = document.createElement('div');

    document.body.appendChild(target);

    expect(() => {
      component = mount(DashboardPage, {
        target,
        context: createHostServicesContext({...createHostServices(), registry: pluginRegistry}),
      });
      flushSync();
    }).toThrow('add failed');

    // A later user change must persist — restoring was cleared by the finally block.
    save.mockReturnValue([{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}]);
    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);

    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-traffic:1'],
    });

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
    expect(saveDashboardLayout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(saveDashboardLayout).toHaveBeenCalledTimes(1);

    void unmount(component);
    target.remove();
  });

  it('forwards resize events to the tile registry', () => {
    const {component, target} = mountPage();
    const item = document.createElement('div');

    Object.assign(item, {gridstackNode: {id: 'widget-a:1', w: 6, h: 4}});

    gridHandlers.get('resizestop')?.(new Event('resizestop'), item);

    expect(resizeWidgetTile).toHaveBeenCalledWith('widget-a:1', {w: 6, h: 4});

    void unmount(component);
    target.remove();
  });

  it('clears pending persistence and destroys tiles on teardown', () => {
    const {component, target} = mountPage();

    // Leave a debounce timer pending to prove teardown flushes it exactly once.
    save.mockReturnValue([{id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3}]);
    gridHandlers.get('change')?.(new Event('change'));
    expect(save).toHaveBeenCalledWith(false, false, expect.any(Function));

    void unmount(component);
    flushSync();

    expect(teardownLog).toContain('destroyAll');
    expect(destroyAllTiles).toHaveBeenCalledWith('host-navigation');
    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [{id: 'widget-a:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: [],
    });

    vi.advanceTimersByTime(500);
    expect(saveDashboardLayout).toHaveBeenCalledTimes(1);

    target.remove();
  });

  it('adds a widget and closes the picker on add', () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([{
      entry: widgetEntry('traffic'),
      module: {createInstance: vi.fn()},
    }]);

    const {component, target} = mountPage();

    const addButton = [...target.querySelectorAll('mndw-button')].find(
      (btn) => btn.textContent?.includes('Add Widget'),
    );

    addButton?.click();
    flushSync();

    const pickerButton = [...document.querySelectorAll('.mndw-floating-panel mndw-button')].find(
      (btn) => btn.textContent?.trim() === 'traffic',
    ) as HTMLButtonElement | undefined;

    pickerButton?.click();
    flushSync();

    expect(addWidgetTile).toHaveBeenCalledWith(
      expect.anything(),
      pluginRegistry,
      fakeGrid,
      'traffic',
      expect.any(Function),
    );
    expect(document.querySelector('.mndw-floating-panel')).toBeNull();

    void unmount(component);
    target.remove();
  });

  it('appends a desktop-added widget to mobileOrder and persists both collections', () => {
    const events: string[] = [];

    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      {entry: widgetEntry('clock'), module: {createInstance: vi.fn()}},
    ]);
    save.mockReturnValue([{id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3}]);
    vi.mocked(addWidgetTile).mockImplementation(() => {
      events.push('tile-added');
      gridHandlers.get('added')?.();

      return 'widget-clock:1';
    });
    vi.mocked(saveDashboardLayout).mockImplementation(() => {
      events.push('persisted');
    });

    const {component, target} = mountPage();

    target.querySelector<HTMLElement>('.mndw-dashboard__toolbar mndw-button')?.click();
    flushSync();
    document.body.querySelector<HTMLElement>('.mndw-floating-panel mndw-button:not(.mndw-floating-panel__close)')
      ?.click();
    flushSync();
    vi.advanceTimersByTime(500);

    expect(events).toEqual(['tile-added', 'persisted']);
    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-clock:1'],
    });

    void unmount(component);
    target.remove();
  });

  it('reproduces desktop add loss when navigation unmounts before debounce flush', () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      {entry: widgetEntry('clock'), module: {createInstance: vi.fn()}},
    ]);
    vi.mocked(addWidgetTile).mockImplementation(() => {
      // GridStack emits `added` during addWidget(), before addWidgetTile returns.
      gridHandlers.get('added')?.();

      return 'widget-clock:1';
    });
    save.mockReturnValue([{id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3}]);

    const {component, target} = mountPage();

    target.querySelector<HTMLElement>('.mndw-dashboard__toolbar mndw-button')?.click();
    flushSync();
    document.body.querySelector<HTMLElement>(
      '.mndw-floating-panel mndw-button:not(.mndw-floating-panel__close)',
    )?.click();
    flushSync();

    // GridStack supplied complete geometry before the add handler returned.
    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-clock:1'],
    });

    void unmount(component);

    // Defense-in-depth flush must not create a duplicate write when no debounce is pending.
    expect(saveDashboardLayout).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('renders the mobile flow instead of the grid when the breakpoint matches', () => {
    mobileState.matches = true;

    const {component, target} = mountPage();

    expect(target.querySelector('.mndw-dashboard__grid-wrapper')).toBeNull();
    expect(target.querySelector('.mndw-mobile-dashboard')).not.toBeNull();

    void unmount(component);
    target.remove();
  });

  it('keeps the dashboard toolbar before the widget renderer', () => {
    const {component, target} = mountPage();
    const page = target.querySelector('.mndw-dashboard-page');
    const toolbar = page?.querySelector('.mndw-dashboard__toolbar');

    expect(page?.firstElementChild).toBe(toolbar);

    void unmount(component);
    target.remove();
  });

  it('switching breakpoints neither disposes controllers nor rewrites persisted geometry', () => {
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 3, y: 2, w: 4, h: 3}],
      mobileOrder: ['widget-clock:1'],
    });
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => ({
      entry: widgetEntry(name),
      module: {createInstance: vi.fn()},
    }));

    const {component} = mountPage();

    mobileState.listener?.({matches: true} as MediaQueryListEvent);
    flushSync();
    mobileState.listener?.({matches: false} as MediaQueryListEvent);
    flushSync();

    expect(removeTileController).not.toHaveBeenCalled();
    expect(destroyAllTiles).not.toHaveBeenCalled();
    expect(saveDashboardLayout).not.toHaveBeenCalled();
    expect(addWidgetTile).toHaveBeenLastCalledWith(
      expect.anything(),
      pluginRegistry,
      fakeGrid,
      'clock',
      expect.any(Function),
      {
        x: 3,
        y: 2,
        w: 4,
        h: 3,
        instanceId: 'clock:1',
      },
    );

    void unmount(component);
  });

  it('does not call resizeWidgetTile while the mobile renderer is active', () => {
    mobileState.matches = true;
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-clock:1'],
    });

    const {component} = mountPage();

    expect(resizeWidgetTile).not.toHaveBeenCalled();

    void unmount(component);
  });

  it('mobile add places the tile below the desktop layout and persists both collections', () => {
    const events: string[] = [];

    mobileState.matches = true;
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 4}],
      mobileOrder: ['widget-clock:1'],
    });
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => ({
      entry: widgetEntry(name),
      module: {createInstance: vi.fn()},
    }));
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      {entry: widgetEntry('weather'), module: {createInstance: vi.fn()}},
    ]);
    vi.mocked(saveDashboardLayout).mockImplementation(() => {
      events.push('persisted');
    });

    const {component, target} = mountPage();

    target.querySelector<HTMLElement>('.mndw-dashboard__toolbar mndw-button')?.click();
    flushSync();
    document.body
      .querySelector<HTMLElement>('.mndw-floating-panel mndw-button:not(.mndw-floating-panel__close)')
      ?.click();
    flushSync();

    expect(events).toEqual(['persisted']);
    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [
        {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 4},
        {id: 'widget-weather:1', x: 0, y: 4, w: 4, h: 3},
      ],
      mobileOrder: ['widget-clock:1', 'widget-weather:1'],
    });

    void unmount(component);
  });

  it('mobile remove updates tiles and mobileOrder and persists immediately', () => {
    mobileState.matches = true;
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1}],
      mobileOrder: ['widget-clock:1'],
    });

    const {component} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();

    expect(removeTileController).toHaveBeenCalledWith('widget-clock:1');
    expect(saveDashboardLayout).toHaveBeenCalledWith({tiles: [], mobileOrder: []});

    void unmount(component);
  });

  it('shows the arrange control only on mobile with more than one widget', () => {
    configureTwoClockWidgets();
    mobileState.matches = false;

    const desktop = mountPage();

    expect(arrangeButton(desktop.target)).toBeUndefined();
    void unmount(desktop.component);

    mobileState.matches = true;

    const mobile = mountPage();

    expect(arrangeButton(mobile.target)).toBeDefined();
    void unmount(mobile.component);
  });

  it('uses current tile titles in the arrange overlay', () => {
    configureTwoClockWidgets();
    currentTitles.set('widget-clock:1', 'WAN download');
    currentTitles.set('widget-clock:2', 'WAN upload');
    mobileState.matches = true;

    const {component, target} = mountPage();

    arrangeButton(target)?.click();
    flushSync();

    expect([...target.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'WAN download',
      'WAN upload',
    ]);
    expect(target.querySelector('[aria-label="Move WAN download down"]')).not.toBeNull();

    void unmount(component);
  });

  it('hides an open overlay when the viewport switches to desktop', () => {
    configureTwoClockWidgets();
    mobileState.matches = true;

    const {component, target} = mountPage();

    arrangeButton(target)?.click();
    flushSync();
    expect(document.querySelector('.mndw-order-overlay')).not.toBeNull();

    mobileState.listener?.({matches: false} as MediaQueryListEvent);
    flushSync();

    expect(document.querySelector('.mndw-order-overlay')).toBeNull();
    expect(arrangeButton(target)).toBeUndefined();

    void unmount(component);
  });

  it('committing the overlay updates mobileOrder, closes it, and persists immediately', () => {
    configureTwoClockWidgets();
    mobileState.matches = true;

    const {component, target} = mountPage();

    arrangeButton(target)?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-label="Move clock down"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('.mndw-floating-panel__close')?.click();
    flushSync();

    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: expect.any(Array),
      mobileOrder: ['widget-clock:2', 'widget-clock:1'],
    });
    expect(document.querySelector('.mndw-order-overlay')).toBeNull();

    void unmount(component);
  });
});
