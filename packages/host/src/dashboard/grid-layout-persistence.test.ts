/* eslint id-blacklist: 0 */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  type DashboardLayout,
  type PersistedGridTile,
  compareTileIds,
  loadDashboardLayout,
  parseWidgetTileId,
  placeTileBelowLayout,
  saveDashboardLayout,
} from './grid-layout-persistence.js';

const GRID_LAYOUT_KEY = 'mndw:dashboard:grid-layout';

const widgetSize = (pluginName: string) => {
  if (pluginName === 'weather') {
    return {w: 4, h: 3, minW: 3, minH: 2};
  }

  if (pluginName === 'clock') {
    return {w: 2, h: 1};
  }

  return undefined;
};

describe('grid layout persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([
    ['widget-weather:1', {pluginName: 'weather', counter: 1}],
    ['widget-weather-forecast:42', {pluginName: 'weather-forecast', counter: 42}],
    ['widget-weather:01', null],
    ['widget-weather:0', null],
    ['widget-weather:-1', null],
    ['widget-weather:1.5', null],
    [`widget-weather:${Number.MAX_SAFE_INTEGER + 1}`, null],
    ['widget-:1', null],
    ['weather:1', null],
  ])('parses valid widget tile IDs and rejects aliases', (tileId, expected) => {
    expect(parseWidgetTileId(tileId)).toEqual(expected);
  });
});

describe('dashboard layout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('orders tile ids by plugin name then numeric counter', () => {
    expect(compareTileIds('widget-a:2', 'widget-a:10')).toBeLessThan(0);
    expect(compareTileIds('widget-b:1', 'widget-a:9')).toBeGreaterThan(0);
    expect(compareTileIds('widget-a:3', 'widget-a:3')).toBe(0);
  });

  it('derives mobileOrder by y, x, then id when the new object has no order', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [
          {id: 'widget-clock:1', x: 4, y: 0, w: 2, h: 1},
          {id: 'widget-weather:1', x: 0, y: 2, w: 4, h: 3},
          {id: 'widget-clock:10', x: 4, y: 4, w: 2, h: 1},
          {id: 'widget-clock:2', x: 4, y: 4, w: 2, h: 1},
        ],
      }),
    );

    const layout = loadDashboardLayout(widgetSize);

    expect(layout?.tiles).toHaveLength(4);
    expect(layout?.mobileOrder).toEqual([
      'widget-clock:1',
      'widget-weather:1',
      'widget-clock:2',
      'widget-clock:10',
    ]);
  });

  it('loads the new object and preserves its mobileOrder over derived order', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [
          {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1},
          {id: 'widget-weather:1', x: 0, y: 2, w: 4, h: 3},
        ],
        mobileOrder: ['widget-weather:1', 'widget-clock:1'],
      }),
    );

    expect(loadDashboardLayout(widgetSize)?.mobileOrder)
      .toEqual(['widget-weather:1', 'widget-clock:1']);
  });

  it('reconciles mobileOrder: drops stale, duplicate, and non-string ids, appends missing', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [
          {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1},
          {id: 'widget-weather:1', x: 0, y: 2, w: 4, h: 3},
        ],
        mobileOrder: ['widget-gone:1', 'widget-clock:1', 'widget-clock:1', 42],
      }),
    );

    expect(loadDashboardLayout(widgetSize)?.mobileOrder)
      .toEqual(['widget-clock:1', 'widget-weather:1']);
  });

  it.each([
    JSON.stringify({tiles: 'nope', mobileOrder: []}),
    JSON.stringify({version: 2, tiles: [], mobileOrder: []}),
    '{}',
    'null',
    '"layout"',
    '[]',
  ])('clears malformed stored shapes: %s', (stored) => {
    localStorage.setItem(GRID_LAYOUT_KEY, stored);

    expect(loadDashboardLayout(widgetSize)).toBeNull();
    expect(localStorage.getItem(GRID_LAYOUT_KEY)).toBeNull();
  });

  it('warns when malformed JSON is cleared', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    localStorage.setItem(GRID_LAYOUT_KEY, '{');

    expect(loadDashboardLayout(widgetSize)).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[mndw] Failed to parse dashboard layout, discarding:',
      expect.any(SyntaxError),
    );
  });

  it('warns when a malformed root is cleared', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    localStorage.setItem(GRID_LAYOUT_KEY, '{}');

    expect(loadDashboardLayout(widgetSize)).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith('[mndw] Malformed dashboard layout, discarding');
  });

  it('skips invalid tiles and normalizes valid tiles without rewriting storage', () => {
    const storedLayout = {
      tiles: [
        {id: 'widget-weather:1', x: 10, y: 2, w: 1, h: 1, extra: 'discarded'},
        {id: 'widget-weather:1', x: 0, y: 0, w: 4, h: 3},
        {id: 'not-a-widget', x: 0, y: 0, w: 4, h: 3},
        {id: 'widget-clock:1', x: 1.5, y: 0, w: 2, h: 1},
        {id: 'widget-clock:2', x: -1, y: 0, w: 2, h: 1},
        {id: 'widget-clock:3', x: 0, y: 0, w: 0, h: 1},
        {id: 'widget-missing:1', x: 0, y: 0, w: 2, h: 1},
        {id: 'widget-clock:4', x: 11, y: 3, w: 4, h: 0},
      ],
    };
    const serialized = JSON.stringify(storedLayout);

    localStorage.setItem(GRID_LAYOUT_KEY, serialized);

    const setItem = vi.spyOn(localStorage, 'setItem');

    expect(loadDashboardLayout(widgetSize)).toEqual({
      tiles: [{id: 'widget-weather:1', x: 9, y: 2, w: 3, h: 2}],
      mobileOrder: ['widget-weather:1'],
    });
    expect(localStorage.getItem(GRID_LAYOUT_KEY)).toBe(serialized);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('clamps restored dimensions to plugin minimums and the twelve-column grid', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [
          {id: 'widget-weather:1', x: 11, y: 0, w: 20, h: 1},
          {id: 'widget-clock:1', x: 10, y: 1, w: 3, h: 1},
        ],
      }),
    );

    expect(loadDashboardLayout(widgetSize)).toEqual({
      tiles: [
        {id: 'widget-weather:1', x: 0, y: 0, w: 12, h: 2},
        {id: 'widget-clock:1', x: 9, y: 1, w: 3, h: 1},
      ],
      mobileOrder: ['widget-weather:1', 'widget-clock:1'],
    });
  });

  it('skips tiles with negative or fractional row positions', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [
          {id: 'widget-weather:1', x: 0, y: -1, w: 4, h: 3},
          {id: 'widget-weather:2', x: 0, y: 1.5, w: 4, h: 3},
          {id: 'widget-weather:3', x: 0, y: 1, w: 4, h: 3},
        ],
      }),
    );

    expect(loadDashboardLayout(widgetSize)).toEqual({
      tiles: [{id: 'widget-weather:3', x: 0, y: 1, w: 4, h: 3}],
      mobileOrder: ['widget-weather:3'],
    });
  });

  it('saves the new object with only persisted fields', () => {
    const layout: DashboardLayout = {
      tiles: [{id: 'widget-weather:1', x: 1, y: 2, w: 4, h: 3}],
      mobileOrder: ['widget-weather:1'],
    };
    const tileWithRuntimeState = {...layout.tiles[0], content: 'runtime state'};

    saveDashboardLayout({
      ...layout,
      tiles: [tileWithRuntimeState as PersistedGridTile],
    });

    expect(JSON.parse(localStorage.getItem(GRID_LAYOUT_KEY) ?? '')).toEqual(layout);
  });

  it('places a mobile-added tile below the existing desktop layout', () => {
    const tiles: PersistedGridTile[] = [
      {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1},
      {id: 'widget-weather:1', x: 4, y: 1, w: 4, h: 3},
    ];

    expect(placeTileBelowLayout(tiles, {w: 4, h: 3, minW: 3, minH: 2}))
      .toEqual({x: 0, y: 4, w: 4, h: 3});
    expect(placeTileBelowLayout([], {w: 2, h: 1})).toEqual({x: 0, y: 0, w: 2, h: 1});
  });

  it('logs storage failures', () => {
    const error = new Error('storage denied');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw error;
    });

    expect(loadDashboardLayout(widgetSize)).toBeNull();
    expect(consoleError).toHaveBeenCalledWith('[mndw] Failed to load dashboard layout:', error);

    vi.restoreAllMocks();

    const saveError = new Error('save denied');
    const saveConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw saveError;
    });

    saveDashboardLayout({
      tiles: [{id: 'widget-weather:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-weather:1'],
    });
    expect(saveConsoleError).toHaveBeenCalledWith('[mndw] Failed to save dashboard layout:', saveError);
  });
});
