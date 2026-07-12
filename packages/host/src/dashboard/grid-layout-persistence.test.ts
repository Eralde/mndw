import {beforeEach, describe, expect, it, vi} from 'vitest';
import {type PersistedGridTile, loadGridLayout, parseWidgetTileId, saveGridLayout} from './grid-layout-persistence.js';

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

  it('returns null when no layout is stored', () => {
    expect(loadGridLayout(widgetSize)).toBeNull();
  });

  it.each(['{', '{}', 'null', '"layout"'])('clears malformed or non-array stored layouts', (storedLayout) => {
    localStorage.setItem(GRID_LAYOUT_KEY, storedLayout);

    expect(loadGridLayout(widgetSize)).toBeNull();
    expect(localStorage.getItem(GRID_LAYOUT_KEY)).toBeNull();
  });

  it('warns when malformed JSON is cleared', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    localStorage.setItem(GRID_LAYOUT_KEY, '{');

    expect(loadGridLayout(widgetSize)).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[mndw] Failed to parse grid dashboard layout, discarding:',
      expect.any(SyntaxError),
    );
  });

  it.each(['{}', 'null', '"layout"'])('warns when a non-array root is cleared', (storedLayout) => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    localStorage.setItem(GRID_LAYOUT_KEY, storedLayout);

    expect(loadGridLayout(widgetSize)).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith('[mndw] Grid dashboard layout is not an array, discarding');
  });

  it('skips invalid tiles and normalizes valid tiles without rewriting storage', () => {
    const storedLayout = [
      {id: 'widget-weather:1', x: 10, y: 2, w: 1, h: 1, extra: 'discarded'},
      {id: 'widget-weather:1', x: 0, y: 0, w: 4, h: 3},
      {id: 'not-a-widget', x: 0, y: 0, w: 4, h: 3},
      {id: 'widget-clock:1', x: 1.5, y: 0, w: 2, h: 1},
      {id: 'widget-clock:2', x: -1, y: 0, w: 2, h: 1},
      {id: 'widget-clock:3', x: 0, y: 0, w: 0, h: 1},
      {id: 'widget-missing:1', x: 0, y: 0, w: 2, h: 1},
      {id: 'widget-clock:4', x: 11, y: 3, w: 4, h: 0},
    ];
    const serialized = JSON.stringify(storedLayout);

    localStorage.setItem(GRID_LAYOUT_KEY, serialized);

    const setItem = vi.spyOn(localStorage, 'setItem');

    expect(loadGridLayout(widgetSize)).toEqual([
      {id: 'widget-weather:1', x: 9, y: 2, w: 3, h: 2},
    ]);
    expect(localStorage.getItem(GRID_LAYOUT_KEY)).toBe(serialized);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('clamps restored dimensions to plugin minimums and the twelve-column grid', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify([
        {id: 'widget-weather:1', x: 11, y: 0, w: 20, h: 1},
        {id: 'widget-clock:1', x: 10, y: 1, w: 3, h: 1},
      ]),
    );

    expect(loadGridLayout(widgetSize)).toEqual([
      {id: 'widget-weather:1', x: 0, y: 0, w: 12, h: 2},
      {id: 'widget-clock:1', x: 9, y: 1, w: 3, h: 1},
    ]);
  });

  it('skips tiles with negative or fractional row positions', () => {
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify([
        {id: 'widget-weather:1', x: 0, y: -1, w: 4, h: 3},
        {id: 'widget-weather:2', x: 0, y: 1.5, w: 4, h: 3},
        {id: 'widget-weather:3', x: 0, y: 1, w: 4, h: 3},
      ]),
    );

    expect(loadGridLayout(widgetSize)).toEqual([{id: 'widget-weather:3', x: 0, y: 1, w: 4, h: 3}]);
  });

  it('saves only persisted tile fields', () => {
    const layout: PersistedGridTile[] = [
      {id: 'widget-weather:1', x: 1, y: 2, w: 4, h: 3},
    ];
    const tileWithRuntimeState = {...layout[0], content: 'runtime state'};

    saveGridLayout([tileWithRuntimeState]);

    expect(JSON.parse(localStorage.getItem(GRID_LAYOUT_KEY) ?? '')).toEqual(layout);
  });

  it('logs storage failures', () => {
    const error = new Error('storage denied');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw error;
    });

    expect(loadGridLayout(widgetSize)).toBeNull();
    expect(consoleError).toHaveBeenCalledWith('[mndw] Failed to load grid dashboard layout:', error);

    vi.restoreAllMocks();

    const saveError = new Error('save denied');
    const saveConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw saveError;
    });

    saveGridLayout([{id: 'widget-weather:1', x: 0, y: 0, w: 4, h: 3}]);
    expect(saveConsoleError).toHaveBeenCalledWith('[mndw] Failed to save grid dashboard layout:', saveError);
  });
});
