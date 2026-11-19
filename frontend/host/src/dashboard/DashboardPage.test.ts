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
  refreshPluginLoadPlaceholders: vi.fn(),
}));

vi.mock('../layout/breakpoint.js', () => ({
  mobileMediaQuery: vi.fn(() => mobileState),
}));

vi.mock('./grid-layout-persistence.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./grid-layout-persistence.js')>(),
  loadDashboardLayout: vi.fn(() => null),
  saveDashboardLayout: vi.fn(() => true),
}));

vi.mock('./widget-counter.js', () => ({
  getNextInstanceId: vi.fn((name: string) => `${name}:1`),
  raiseInstanceCounter: vi.fn(),
}));

vi.mock('../services/storage.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/storage.service.js')>();

  return {...actual, clearInstanceStorage: vi.fn(actual.clearInstanceStorage)};
});

vi.mock('../runtime/plugin-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/plugin-registry.js')>(),
  pluginRegistry: {get: vi.fn(), getWidgets: vi.fn(() => [])},
}));

import {addWidgetTile, resizeWidgetTile} from './grid-dashboard-setup.js';
import {destroyAllTiles, ensureTileController, removeTileController} from './tile-controller.js';
import {loadDashboardLayout, parseWidgetTileId, saveDashboardLayout} from './grid-layout-persistence.js';
import {PluginRegistry, pluginRegistry} from '../runtime/plugin-registry.js';
import {appState} from '../state/app.svelte.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {raiseInstanceCounter} from './widget-counter.js';
import {clearInstanceStorage} from '../services/storage.service.js';
import {
  applyPluginListSnapshot,
  getPluginLoadListOutcome,
  getPluginLoadState,
  getPluginLoadStates,
  replacePluginLoadStates,
  setPluginLoadListOutcome,
  setPluginLoadState,
} from '../runtime/plugin-load-state.svelte.js';
import DashboardPage from './DashboardPage.svelte';
import OverlayHost from '../components/overlay/OverlayHost.svelte';
import {defaultOverlayRuntime} from '../services/overlay/overlay-manager.svelte.js';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import {toast} from '../services/toast/toast.svelte.js';
import {loadSandboxPlugin} from '../runtime/sandbox-loader.js';

const overlayHosts: ReturnType<typeof mount>[] = [];

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
  replacePluginLoadStates([widgetEntry('clock')]);
  setPluginLoadState('clock', 'loaded');
  vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
    name === 'clock'
      ? {entry: widgetEntry(name), module: {createInstance: vi.fn()}}
      : undefined
  );
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
  if (Object.keys(getPluginLoadStates()).length === 0 && getPluginLoadListOutcome() === 'ok') {
    const layout = vi.mocked(loadDashboardLayout).getMockImplementation()?.(
      () => undefined,
      {listOutcome: 'ok', getPlugin: getPluginLoadState},
    );
    const entries = new Map<string, WidgetListEntry>();

    for (const tile of layout?.tiles ?? []) {
      const parsed = parseWidgetTileId(tile.id);
      const plugin = parsed === null ? undefined : pluginRegistry.get(parsed.pluginName);

      if (plugin?.entry.type === 'widget') {
        entries.set(plugin.entry.name, plugin.entry);
      }
    }

    if (entries.size > 0) {
      replacePluginLoadStates([...entries.values()]);

      for (const name of entries.keys()) {
        setPluginLoadState(name, 'loaded');
      }
    }
  }

  const target = document.createElement('div');
  const overlayTarget = document.createElement('div');

  document.body.appendChild(target);
  document.body.appendChild(overlayTarget);
  overlayHosts.push(mount(OverlayHost, {target: overlayTarget}));

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
    appState.locale = 'en';
    appState.pluginLoadError = null;
    replacePluginLoadStates([]);
    setPluginLoadListOutcome('ok');
    removeCallbacks.clear();
    mobileFrames.clear();
    currentTitles.clear();
    gridHandlers.clear();
    teardownLog.length = 0;
    save.mockReturnValue([]);
    destroy.mockClear();
    vi.mocked(loadDashboardLayout).mockReturnValue(null);
    vi.mocked(saveDashboardLayout).mockReset()
      .mockReturnValue(true);
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([]);
    vi.mocked(addWidgetTile).mockReturnValue('widget-x:1');
    vi.mocked(ensureTileController).mockClear();
    vi.mocked(removeTileController).mockClear();
    vi.mocked(clearInstanceStorage).mockClear();
    getGridItems.mockReset();
    getGridItems.mockReturnValue([]);
    localStorage.removeItem('mndw:plugin:clock:instance:clock:1:settings');
    localStorage.removeItem('mndw:plugin:clock:instance:clock:2:settings');
  });

  afterEach(async () => {
    for (const layer of [...defaultOverlayRuntime.store.layers]) {
      layer.close();
    }

    await vi.waitFor(() => {
      flushSync();
      expect(defaultOverlayRuntime.store.layers).toHaveLength(0);
    });
    await Promise.all(overlayHosts.splice(0).map((overlay) => unmount(overlay)));
    toast.clear();
    replacePluginLoadStates([]);
    setPluginLoadListOutcome('pending');
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

  it('restores failed runnable placeholders and removes them from both saved collections', () => {
    replacePluginLoadStates([widgetEntry('broken')]);
    setPluginLoadState('broken', 'failed');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-broken:5', x: 9, y: 3, w: 2, h: 1}],
      mobileOrder: ['widget-broken:5'],
    });

    const desktop = mountPage();

    expect(addWidgetTile).toHaveBeenCalledWith(
      expect.anything(),
      pluginRegistry,
      fakeGrid,
      'broken',
      expect.any(Function),
      {x: 9, y: 3, w: 2, h: 1, instanceId: 'broken:5'},
    );
    expect(desktop.target.querySelector('.mndw-empty-state')).toBeNull();

    const onRemove = vi.mocked(addWidgetTile).mock.calls[0]?.[4];

    onRemove?.('widget-broken:5');

    expect(saveDashboardLayout).toHaveBeenCalledWith({tiles: [], mobileOrder: []});
    void unmount(desktop.component);
    desktop.target.remove();

    mobileState.matches = true;

    const mobile = mountPage();

    expect(ensureTileController).toHaveBeenCalledWith(
      expect.anything(),
      pluginRegistry,
      'broken',
      'broken:5',
      expect.any(Function),
    );
    expect(mobile.target.querySelector('.mndw-mobile-tile')).not.toBeNull();
    expect(mobile.target.querySelector('.mndw-empty-state')).toBeNull();

    void unmount(mobile.component);
    mobile.target.remove();
  });

  it('keeps dormant tiles and their mobile-order slots when visible desktop geometry changes', () => {
    const dormantEntry = {...widgetEntry('dormant'), enabled: false};

    replacePluginLoadStates([widgetEntry('clock'), dormantEntry]);
    setPluginLoadState('clock', 'loaded');
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
      name === 'clock'
        ? {entry: widgetEntry(name), module: {createInstance: vi.fn()}}
        : undefined
    );
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [
        {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1},
        {id: 'widget-dormant:7', x: 5, y: 2, w: 3, h: 2},
      ],
      mobileOrder: ['widget-dormant:7', 'widget-clock:1'],
    });
    save.mockReturnValue([{id: 'widget-clock:1', x: 1, y: 0, w: 2, h: 1}]);

    const {component, target} = mountPage();

    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);

    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [
        {id: 'widget-clock:1', x: 1, y: 0, w: 2, h: 1},
        {id: 'widget-dormant:7', x: 5, y: 2, w: 3, h: 2},
      ],
      mobileOrder: ['widget-dormant:7', 'widget-clock:1'],
    });

    void unmount(component);
    target.remove();
  });

  it('does not save layout while the plugin list request has failed', () => {
    setPluginLoadListOutcome('failed');
    appState.pluginLoadError = 'list';
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:2', x: 4, y: 1, w: 3, h: 2}],
      mobileOrder: ['widget-clock:2'],
    });

    const {component, target} = mountPage();

    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);
    void unmount(component);

    expect(saveDashboardLayout).not.toHaveBeenCalled();
    target.remove();
  });

  it('restores stored tiles when a failed plugin-list request later succeeds', () => {
    setPluginLoadListOutcome('failed');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:2', x: 4, y: 1, w: 3, h: 2}],
      mobileOrder: ['widget-clock:2'],
    });

    const {component, target} = mountPage();

    expect(addWidgetTile).not.toHaveBeenCalled();

    replacePluginLoadStates([widgetEntry('clock')]);
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(addWidgetTile).toHaveBeenCalledWith(
      expect.anything(),
      pluginRegistry,
      fakeGrid,
      'clock',
      expect.any(Function),
      {x: 4, y: 1, w: 3, h: 2, instanceId: 'clock:2'},
    );

    void unmount(component);
    target.remove();
  });

  it.each([
    {renderer: 'desktop', mobile: false},
    {renderer: 'mobile', mobile: true},
  ])('drops deleted tiles and retains dormant tiles after list recovery on $renderer', ({mobile}) => {
    const dormantEntry = {...widgetEntry('dormant'), enabled: false};

    setPluginLoadListOutcome('failed');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [
        {id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3},
        {id: 'widget-deleted:1', x: 4, y: 0, w: 4, h: 3},
        {id: 'widget-dormant:7', x: 8, y: 0, w: 3, h: 2},
      ],
      mobileOrder: ['widget-deleted:1', 'widget-dormant:7', 'widget-clock:1'],
    });
    mobileState.matches = mobile;

    const {component, target} = mountPage();

    expect(saveDashboardLayout).not.toHaveBeenCalled();
    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(0);

    replacePluginLoadStates([widgetEntry('clock'), dormantEntry]);
    setPluginLoadState('clock', 'loaded');
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [
        {id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3},
        {id: 'widget-dormant:7', x: 8, y: 0, w: 3, h: 2},
      ],
      mobileOrder: ['widget-dormant:7', 'widget-clock:1'],
    });

    if (mobile) {
      expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(1);
      expect(ensureTileController).toHaveBeenCalledTimes(1);
      expect(ensureTileController).toHaveBeenCalledWith(
        expect.anything(),
        pluginRegistry,
        'clock',
        'clock:1',
        expect.any(Function),
      );
    } else {
      expect(addWidgetTile).toHaveBeenCalledTimes(1);
      expect(addWidgetTile).toHaveBeenCalledWith(
        expect.anything(),
        pluginRegistry,
        fakeGrid,
        'clock',
        expect.any(Function),
        {x: 0, y: 0, w: 4, h: 3, instanceId: 'clock:1'},
      );
    }

    void unmount(component);
    target.remove();
  });

  it('removes tiles absent from an initially successful plugin list', () => {
    replacePluginLoadStates([widgetEntry('clock')]);
    setPluginLoadState('clock', 'loaded');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [
        {id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3},
        {id: 'widget-deleted:1', x: 4, y: 0, w: 4, h: 3},
      ],
      mobileOrder: ['widget-deleted:1', 'widget-clock:1'],
    });

    const {component, target} = mountPage();

    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 4, h: 3}],
      mobileOrder: ['widget-clock:1'],
    });

    void unmount(component);
    target.remove();
  });

  it('reconciles live disable and approval changes while preserving tile order, geometry, and storage', () => {
    mobileState.matches = true;
    const clock = widgetEntry('clock');
    const weather = widgetEntry('weather');
    const broken = widgetEntry('broken');
    const entries = new Map([
      ['clock', clock],
      ['weather', weather],
      ['broken', broken],
    ]);
    applyPluginListSnapshot([clock, weather, broken]);
    setPluginLoadState('clock', 'loaded');
    setPluginLoadState('weather', 'loaded');
    setPluginLoadState('broken', 'failed');
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => {
      const entry = entries.get(name);

      return entry === undefined ? undefined : {entry, module: {createInstance: vi.fn()}};
    });
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      {entry: clock, module: {createInstance: vi.fn()}},
      {entry: weather, module: {createInstance: vi.fn()}},
      {entry: broken, module: {createInstance: vi.fn()}},
    ]);
    const layout = {
      tiles: [
        {id: 'widget-clock:1', x: 3, y: 2, w: 4, h: 3},
        {id: 'widget-weather:1', x: 8, y: 1, w: 3, h: 2},
        {id: 'widget-broken:1', x: 1, y: 6, w: 4, h: 3},
      ],
      mobileOrder: ['widget-weather:1', 'widget-clock:1', 'widget-broken:1'],
    };
    vi.mocked(loadDashboardLayout).mockReturnValue(layout);
    const storageKey = 'mndw:plugin:clock:instance:clock:1:settings';
    localStorage.setItem(storageKey, 'saved');

    const {component, target} = mountPage();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(3);
    expect(target.querySelector('.mndw-mobile-dashboard')?.children[0]?.firstElementChild)
      .toBe(mobileFrames.get('widget-weather:1'));

    applyPluginListSnapshot([{...clock, enabled: false}, weather, broken]);
    setPluginLoadState('weather', 'loaded');
    setPluginLoadState('broken', 'failed');
    flushSync();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(2);
    expect(target.querySelector('.mndw-mobile-dashboard')?.children[0]?.firstElementChild)
      .toBe(mobileFrames.get('widget-weather:1'));
    expect(removeTileController).toHaveBeenCalledWith('widget-clock:1', {clearStorage: false});
    expect(removeTileController).not.toHaveBeenCalledWith('widget-broken:1', expect.anything());
    expect(getPluginLoadState('broken')?.status).toBe('failed');
    expect(localStorage.getItem(storageKey)).toBe('saved');

    applyPluginListSnapshot([{...clock, approval: 'pending'}, weather, broken]);
    setPluginLoadState('weather', 'loaded');
    setPluginLoadState('broken', 'failed');
    flushSync();
    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(2);

    applyPluginListSnapshot([clock, weather, broken]);
    setPluginLoadState('clock', 'loaded');
    setPluginLoadState('weather', 'loaded');
    setPluginLoadState('broken', 'failed');
    flushSync();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(3);
    const mobileDashboard = target.querySelector('.mndw-mobile-dashboard');

    expect(mobileDashboard === null ? [] : [...mobileDashboard.children].map((tile) => tile.firstElementChild))
      .toEqual([
        mobileFrames.get('widget-weather:1'),
        mobileFrames.get('widget-clock:1'),
        mobileFrames.get('widget-broken:1'),
      ]);
    expect(loadDashboardLayout).toHaveReturnedWith(layout);
    expect(saveDashboardLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBe('saved');

    localStorage.removeItem(storageKey);
    void unmount(component);
  });

  it('removes a live-deleted tile and clears its instance storage', () => {
    mobileState.matches = true;
    const clock = widgetEntry('clock');
    const availablePlugins = new Set(['clock']);
    applyPluginListSnapshot([clock]);
    setPluginLoadState('clock', 'loaded');
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
      availablePlugins.has(name)
        ? {entry: clock, module: {createInstance: vi.fn()}}
        : undefined
    );
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      {entry: clock, module: {createInstance: vi.fn()}},
    ]);
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 3, y: 2, w: 4, h: 3}],
      mobileOrder: ['widget-clock:1'],
    });
    const storageKey = 'mndw:plugin:clock:instance:clock:1:settings';
    localStorage.setItem(storageKey, 'saved');

    const {component, target} = mountPage();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(1);

    availablePlugins.delete('clock');
    applyPluginListSnapshot([]);
    flushSync();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(0);
    expect(saveDashboardLayout).toHaveBeenLastCalledWith({tiles: [], mobileOrder: []});
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(clearInstanceStorage).toHaveBeenCalledOnce();
    expect(clearInstanceStorage).toHaveBeenCalledWith('clock', 'clock:1');

    void unmount(component);
  });

  it('does not resurrect or double-clear pending Undo when its plugin is live-deleted', async () => {
    mobileState.matches = true;
    const clock = widgetEntry('clock');
    const weather = widgetEntry('weather');
    const availablePlugins = new Set(['clock', 'weather']);
    applyPluginListSnapshot([clock, weather]);
    setPluginLoadState('clock', 'loaded');
    setPluginLoadState('weather', 'loaded');
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
      availablePlugins.has(name)
        ? {entry: name === 'clock' ? clock : weather, module: {createInstance: vi.fn()}}
        : undefined
    );
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      {entry: clock, module: {createInstance: vi.fn()}},
      {entry: weather, module: {createInstance: vi.fn()}},
    ]);
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [
        {id: 'widget-clock:1', x: 3, y: 2, w: 4, h: 3},
        {id: 'widget-weather:1', x: 8, y: 1, w: 3, h: 2},
      ],
      mobileOrder: ['widget-weather:1', 'widget-clock:1'],
    });
    const storageKey = 'mndw:plugin:clock:instance:clock:1:settings';
    localStorage.setItem(storageKey, 'saved');

    const {component, target} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();
    const undo = toast.toasts[0]?.action?.onAction;

    expect(localStorage.getItem(storageKey)).toBe('saved');

    availablePlugins.delete('clock');
    applyPluginListSnapshot([weather]);
    setPluginLoadState('weather', 'loaded');
    flushSync();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(1);
    expect(saveDashboardLayout).toHaveBeenLastCalledWith({
      tiles: [{id: 'widget-weather:1', x: 8, y: 1, w: 3, h: 2}],
      mobileOrder: ['widget-weather:1'],
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(toast.toasts).toHaveLength(0);
    expect(clearInstanceStorage).toHaveBeenCalledOnce();
    expect(clearInstanceStorage).toHaveBeenCalledWith('clock', 'clock:1');

    await undo?.();
    flushSync();

    expect(target.querySelectorAll('.mndw-mobile-tile')).toHaveLength(1);
    expect(saveDashboardLayout).toHaveBeenLastCalledWith({
      tiles: [{id: 'widget-weather:1', x: 8, y: 1, w: 3, h: 2}],
      mobileOrder: ['widget-weather:1'],
    });
    expect(clearInstanceStorage).toHaveBeenCalledOnce();
    expect(clearInstanceStorage).toHaveBeenCalledWith('clock', 'clock:1');

    void unmount(component);
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

  it('shows one sticky warning for failed saves and dismisses it after a successful save', () => {
    const {component, target} = mountPage();

    vi.mocked(saveDashboardLayout)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);

    expect(toast.toasts).toMatchObject([{
      key: 'dashboard-layout-save',
      message: 'Dashboard changes were not saved. Browser storage may be unavailable or full.',
      variant: 'warning',
      duration: 0,
    }]);

    const warningId = toast.toasts[0]?.id;

    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);

    expect(toast.toasts).toHaveLength(1);
    expect(toast.toasts[0]?.id).toBe(warningId);

    gridHandlers.get('change')?.(new Event('change'));
    vi.advanceTimersByTime(500);

    expect(saveDashboardLayout).toHaveBeenCalledTimes(3);
    expect(toast.toasts).toEqual([]);

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

  it('scrolls to and briefly highlights an added widget with reduced motion enabled', async () => {
    const trafficPlugin = {
      entry: widgetEntry('traffic'),
      module: {createInstance: vi.fn()},
    };
    const newTile = document.createElement('div');
    const scrollIntoView = vi.fn();

    newTile.className = 'mndw-grid-tile';
    newTile.dataset.widgetId = 'widget-traffic:1';
    newTile.scrollIntoView = scrollIntoView;
    vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true})));

    replacePluginLoadStates([trafficPlugin.entry]);
    setPluginLoadState('traffic', 'loaded');
    vi.mocked(pluginRegistry).get.mockReturnValue(trafficPlugin);
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([trafficPlugin]);
    save.mockReturnValue([{id: 'widget-traffic:1', x: 0, y: 0, w: 4, h: 3}]);
    vi.mocked(addWidgetTile).mockImplementation(() => {
      gridHandlers.get('added')?.(new Event('added'));
      document.querySelector('.grid-stack')?.append(newTile);

      return 'widget-traffic:1';
    });

    const {component, target} = mountPage();

    try {
      const addButton = [...target.querySelectorAll('mndw-button')].find(
        (btn) => btn.textContent?.includes('Add widget'),
      );

      addButton?.focus();
      expect(document.activeElement).toBe(addButton);
      addButton?.click();
      flushSync();

      const pickerButton = [...document.querySelectorAll('.mndw-floating-panel mndw-button')].find(
        (btn) => btn.querySelector('.mndw-floating-panel__label')?.textContent?.trim() === 'traffic',
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
      await vi.waitFor(() => {
        flushSync();
        expect(document.querySelector('.mndw-floating-panel')).toBeNull();
        expect(document.activeElement).toBe(
          target.querySelector('.mndw-dashboard__toolbar mndw-button'),
        );
      });
      await vi.waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({behavior: 'auto', block: 'center'});
        expect(newTile.classList.contains('mndw-grid-tile--newly-added')).toBe(true);
      });

      vi.advanceTimersByTime(1600);

      expect(newTile.classList.contains('mndw-grid-tile--newly-added')).toBe(false);
    } finally {
      await unmount(component);
      target.remove();
    }
  });

  it('clears the earlier highlight when a second widget is added within 1.6 seconds', async () => {
    const trafficPlugin = {entry: widgetEntry('traffic'), module: {createInstance: vi.fn()}};
    const weatherPlugin = {entry: widgetEntry('weather'), module: {createInstance: vi.fn()}};
    const addedTiles = new Map<string, HTMLElement>();

    vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true})));
    replacePluginLoadStates([trafficPlugin.entry, weatherPlugin.entry]);
    setPluginLoadState('traffic', 'loaded');
    setPluginLoadState('weather', 'loaded');
    vi.mocked(pluginRegistry).get.mockImplementation((name: string) =>
      name === 'traffic' ? trafficPlugin : name === 'weather' ? weatherPlugin : undefined
    );
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([trafficPlugin, weatherPlugin]);
    vi.mocked(addWidgetTile).mockImplementation((_services, _registry, _grid, name) => {
      const id = `widget-${name}:1`;
      const tile = document.createElement('div');

      tile.className = 'mndw-grid-tile';
      tile.dataset.widgetId = id;
      document.querySelector('.grid-stack')?.append(tile);
      addedTiles.set(name, tile);
      gridHandlers.get('added')?.(new Event('added'));

      return id;
    });

    const {component, target} = mountPage();

    const addWidget = async (name: string): Promise<void> => {
      const addButton = [...target.querySelectorAll('mndw-button')].find(
        (btn) => btn.textContent?.includes('Add widget'),
      );

      addButton?.click();
      flushSync();

      const pickerButton = [...document.querySelectorAll('.mndw-floating-panel mndw-button')].find(
        (btn) => btn.querySelector('.mndw-floating-panel__label')?.textContent?.trim() === name,
      ) as HTMLButtonElement | undefined;

      pickerButton?.click();
      flushSync();
      await vi.waitFor(() => expect(document.querySelector('.mndw-floating-panel')).toBeNull());
      await vi.waitFor(() =>
        expect(addedTiles.get(name)?.classList.contains('mndw-grid-tile--newly-added')).toBe(true)
      );
    };

    try {
      await addWidget('traffic');
      await addWidget('weather');

      expect(addedTiles.get('traffic')?.classList.contains('mndw-grid-tile--newly-added')).toBe(false);
      expect(addedTiles.get('weather')?.classList.contains('mndw-grid-tile--newly-added')).toBe(true);

      vi.advanceTimersByTime(1600);

      expect(addedTiles.get('traffic')?.classList.contains('mndw-grid-tile--newly-added')).toBe(false);
      expect(addedTiles.get('weather')?.classList.contains('mndw-grid-tile--newly-added')).toBe(false);
    } finally {
      await unmount(component);
      target.remove();
    }
  });

  it('adds a sandbox widget after sandbox loading reports a successful list', async () => {
    vi.stubGlobal('__MNDW_SANDBOX__', 'virtual');
    setPluginLoadListOutcome('pending');

    const sandboxRegistry = new PluginRegistry();
    const services = createHostServices();

    await loadSandboxPlugin({
      importPluginModule: () => Promise.resolve({createInstance: vi.fn()}),
      importManifestModule: () =>
        Promise.resolve({default: {
          manifestVersion: 1,
          name: 'traffic',
          version: '0.0.0',
          type: 'widget',
          label: 'Traffic',
          entry: 'index.js',
          size: {w: 4, h: 3, minW: 2, minH: 2},
        }}),
      registry: sandboxRegistry,
      catalogService: services.catalog,
      getLocale: () => services.locale.getLocale(),
      pluginContextServices: {} as never,
    });

    vi.mocked(pluginRegistry).get.mockImplementation((name: string) => sandboxRegistry.get(name));
    vi.mocked(pluginRegistry).getWidgets.mockImplementation(() => sandboxRegistry.getWidgets());
    vi.mocked(addWidgetTile).mockImplementation(() => {
      gridHandlers.get('added')?.(new Event('added'));

      return 'widget-traffic:1';
    });

    const {component, target} = mountPage();

    try {
      expect(getPluginLoadListOutcome()).toBe('ok');

      const addButton = [...target.querySelectorAll('mndw-button')].find(
        (button) => button.textContent?.includes('Add widget'),
      );

      addButton?.click();
      flushSync();

      const pickerButton = [...document.querySelectorAll('.mndw-floating-panel mndw-button')].find(
        (button) => button.querySelector('.mndw-floating-panel__label')?.textContent?.trim() === 'Traffic',
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
      expect(saveDashboardLayout).toHaveBeenCalled();
    } finally {
      await unmount(component);
      target.remove();
    }
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

      return true;
    });

    const {component, target} = mountPage();

    target.querySelector<HTMLElement>('.mndw-empty-state mndw-button')?.click();
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

    target.querySelector<HTMLElement>('.mndw-empty-state mndw-button')?.click();
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

  it('points at the banner and offers no CTA when the plugin catalog failed to load', () => {
    appState.pluginLoadError = 'list';

    const {component, target} = mountPage();

    const empty = target.querySelector('.mndw-empty-state');

    expect(empty?.getAttribute('role')).toBeNull();
    expect(empty?.textContent).toContain('Widgets unavailable');
    expect(empty?.textContent).toContain('Plugins could not be loaded — see the message above.');
    expect(target.querySelector('.mndw-empty-state a')).toBeNull();
    expect(target.querySelector('.mndw-empty-state mndw-button')).toBeNull();

    void unmount(component);
    target.remove();
  });

  it('explains and links to the plugin manager when no installed plugins provide widgets', () => {
    const {component, target} = mountPage();

    const empty = target.querySelector('.mndw-empty-state');

    expect(empty?.getAttribute('role')).toBeNull();
    expect(empty?.textContent).toContain('No widgets available');
    expect(empty?.textContent).toContain('No enabled plugins provide widgets.');

    const link = empty?.querySelector<HTMLAnchorElement>('a');

    expect(link?.getAttribute('href')).toBe('/settings/plugins');
    expect(link?.textContent?.trim()).toBe('Manage plugins');
    expect([...target.querySelectorAll('mndw-button')].some(
      (button) => button.textContent?.includes('Add widget'),
    )).toBe(false);

    void unmount(component);
    target.remove();
  });

  it('explains the next step with a primary add button when widgets exist but none were added', async () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([{
      entry: widgetEntry('clock'),
      module: {createInstance: vi.fn()},
    }]);

    const {component, target} = mountPage();

    // Custom element upgrade reflects the variant attribute asynchronously.
    await Promise.resolve();
    await Promise.resolve();

    const empty = target.querySelector('.mndw-empty-state');

    expect(empty?.getAttribute('role')).toBeNull();
    expect(empty?.textContent).toContain('Dashboard is empty');
    expect(empty?.textContent).toContain('Add a widget to get started.');

    const button = empty?.querySelector('mndw-button');

    expect(button?.textContent).toContain('Add widget');
    expect(button?.getAttribute('variant')).toBe('primary');
    // The empty state owns the CTA; the toolbar keeps no duplicate button.
    expect(target.querySelector('.mndw-dashboard__toolbar mndw-button')).toBeNull();

    button?.click();
    flushSync();

    expect(document.querySelector('.mndw-floating-panel')).not.toBeNull();

    void unmount(component);
    target.remove();
  });

  it('renders the no-widget-plugins empty state in Russian', () => {
    appState.locale = 'ru';

    const {component, target} = mountPage();

    const empty = target.querySelector('.mndw-empty-state');

    expect(empty?.textContent).toContain('Нет доступных виджетов');
    expect(empty?.textContent).toContain('Ни один включённый плагин не предоставляет виджетов.');
    expect(empty?.querySelector<HTMLAnchorElement>('a')?.textContent?.trim())
      .toBe('Управление плагинами');

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

      return true;
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
    replacePluginLoadStates([widgetEntry('clock')]);
    setPluginLoadState('clock', 'loaded');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1}],
      mobileOrder: ['widget-clock:1'],
    });

    const {component} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();

    expect(removeTileController).toHaveBeenCalledWith('widget-clock:1', {clearStorage: false});
    expect(saveDashboardLayout).toHaveBeenCalledWith({tiles: [], mobileOrder: []});
    expect(toast.toasts[0]).toMatchObject({
      message: 'Widget “clock” removed',
      action: {label: 'Undo'},
      duration: 8000,
    });

    void unmount(component);
  });

  it('undo restores the same tile geometry, mobile position, and instance controller', async () => {
    mobileState.matches = true;
    replacePluginLoadStates([widgetEntry('clock'), widgetEntry('weather')]);
    setPluginLoadState('clock', 'loaded');
    setPluginLoadState('weather', 'loaded');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [
        {id: 'widget-clock:1', x: 3, y: 2, w: 4, h: 3},
        {id: 'widget-weather:1', x: 8, y: 2, w: 3, h: 2},
      ],
      mobileOrder: ['widget-weather:1', 'widget-clock:1'],
    });
    localStorage.setItem('mndw:plugin:clock:instance:clock:1:settings', 'saved');

    const {component} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();

    await toast.toasts[0]?.action?.onAction();
    flushSync();

    expect(saveDashboardLayout).toHaveBeenLastCalledWith({
      tiles: [
        {id: 'widget-clock:1', x: 3, y: 2, w: 4, h: 3},
        {id: 'widget-weather:1', x: 8, y: 2, w: 3, h: 2},
      ],
      mobileOrder: ['widget-weather:1', 'widget-clock:1'],
    });
    expect(ensureTileController).toHaveBeenCalledWith(
      expect.anything(),
      pluginRegistry,
      'clock',
      'clock:1',
      expect.any(Function),
    );
    expect(toast.toasts).toHaveLength(0);
    expect(localStorage.getItem('mndw:plugin:clock:instance:clock:1:settings')).toBe('saved');

    localStorage.removeItem('mndw:plugin:clock:instance:clock:1:settings');
    void unmount(component);
  });

  it('clears removed instance storage when the undo toast expires', () => {
    mobileState.matches = true;
    replacePluginLoadStates([widgetEntry('clock')]);
    setPluginLoadState('clock', 'loaded');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1}],
      mobileOrder: ['widget-clock:1'],
    });

    const {component} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();
    expect(toast.toasts).toHaveLength(1);

    vi.advanceTimersByTime(8000);
    flushSync();

    expect(toast.toasts).toHaveLength(0);
    expect(localStorage.getItem('mndw:plugin:clock:instance:clock:1:settings')).toBeNull();

    void unmount(component);
  });

  it('clears the earlier removal storage when a later removal replaces its undo toast', () => {
    mobileState.matches = true;
    configureTwoClockWidgets();
    localStorage.setItem('mndw:plugin:clock:instance:clock:1:settings', 'first');
    localStorage.setItem('mndw:plugin:clock:instance:clock:2:settings', 'second');

    const {component} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();
    removeCallbacks.get('widget-clock:2')?.('widget-clock:2');
    flushSync();

    expect(toast.toasts).toHaveLength(1);
    expect(localStorage.getItem('mndw:plugin:clock:instance:clock:1:settings')).toBeNull();
    expect(localStorage.getItem('mndw:plugin:clock:instance:clock:2:settings')).toBe('second');

    void unmount(component);
  });

  it('clears pending removal storage when leaving the dashboard', async () => {
    mobileState.matches = true;
    replacePluginLoadStates([widgetEntry('clock')]);
    setPluginLoadState('clock', 'loaded');
    vi.mocked(loadDashboardLayout).mockReturnValue({
      tiles: [{id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1}],
      mobileOrder: ['widget-clock:1'],
    });
    localStorage.setItem('mndw:plugin:clock:instance:clock:1:settings', 'saved');

    const {component} = mountPage();

    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    flushSync();
    expect(localStorage.getItem('mndw:plugin:clock:instance:clock:1:settings')).toBe('saved');

    await unmount(component);

    expect(localStorage.getItem('mndw:plugin:clock:instance:clock:1:settings')).toBeNull();
  });

  it('keeps desktop removal and mobile ordering frozen until plugin list recovery', () => {
    configureTwoClockWidgets();
    currentTitles.set('widget-clock:1', 'first clock');
    currentTitles.set('widget-clock:2', 'second clock');
    setPluginLoadListOutcome('failed');

    const {component, target} = mountPage();

    gridHandlers.get('removed')?.(new Event('removed'), [{id: 'widget-clock:1'}]);
    expect(removeTileController).not.toHaveBeenCalled();
    expect(saveDashboardLayout).not.toHaveBeenCalled();

    mobileState.listener?.({matches: true} as MediaQueryListEvent);
    flushSync();
    removeCallbacks.get('widget-clock:1')?.('widget-clock:1');
    arrangeButton(target)?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-label="Move first clock down"]')?.click();
    flushSync();
    target.querySelector<HTMLButtonElement>('.mndw-overlay-dialog__close')?.click();
    flushSync();

    expect(removeTileController).not.toHaveBeenCalled();
    expect(saveDashboardLayout).not.toHaveBeenCalled();

    replacePluginLoadStates([widgetEntry('clock')]);
    setPluginLoadState('clock', 'loaded');
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: [
        {id: 'widget-clock:1', x: 0, y: 0, w: 2, h: 1},
        {id: 'widget-clock:2', x: 2, y: 0, w: 2, h: 1},
      ],
      mobileOrder: ['widget-clock:1', 'widget-clock:2'],
    });

    arrangeButton(target)?.click();
    flushSync();
    expect([...document.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'first clock',
      'second clock',
    ]);

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

    expect([...document.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'WAN download',
      'WAN upload',
    ]);
    expect(document.querySelector('[aria-label="Move WAN download down"]')).not.toBeNull();

    void unmount(component);
  });

  it('hides an open overlay when the viewport switches to desktop', async () => {
    configureTwoClockWidgets();
    mobileState.matches = true;

    const {component, target} = mountPage();

    arrangeButton(target)?.click();
    flushSync();
    expect(document.querySelector('.mndw-order-overlay')).not.toBeNull();

    mobileState.listener?.({matches: false} as MediaQueryListEvent);
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.mndw-order-overlay')).toBeNull();
    });
    expect(arrangeButton(target)).toBeUndefined();

    void unmount(component);
  });

  it('Save commits the overlay mobileOrder, closes it, and persists immediately', async () => {
    configureTwoClockWidgets();
    currentTitles.set('widget-clock:1', 'first clock');
    currentTitles.set('widget-clock:2', 'second clock');
    mobileState.matches = true;

    const {component, target} = mountPage();

    arrangeButton(target)?.click();
    flushSync();
    expect([...document.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'first clock',
      'second clock',
    ]);
    vi.mocked(saveDashboardLayout).mockClear();

    document.querySelector<HTMLButtonElement>('[aria-label="Move first clock down"]')?.click();
    flushSync();

    const saveButton = [...document.querySelectorAll('mndw-button')].find((button) =>
      button.textContent?.trim() === 'Save'
    );

    expect(saveButton).not.toBeNull();
    saveButton?.click();
    flushSync();

    expect(saveDashboardLayout).toHaveBeenCalledTimes(1);
    expect(saveDashboardLayout).toHaveBeenCalledWith({
      tiles: expect.any(Array),
      mobileOrder: ['widget-clock:2', 'widget-clock:1'],
    });
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.mndw-order-overlay')).toBeNull();
    });

    arrangeButton(target)?.click();
    flushSync();
    expect([...document.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'second clock',
      'first clock',
    ]);

    void unmount(component);
  });

  it('closing the arrange overlay with × discards the draft and leaves mobileOrder unchanged', async () => {
    configureTwoClockWidgets();
    currentTitles.set('widget-clock:1', 'first clock');
    currentTitles.set('widget-clock:2', 'second clock');
    mobileState.matches = true;

    const {component, target} = mountPage();

    arrangeButton(target)?.click();
    flushSync();
    expect([...document.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'first clock',
      'second clock',
    ]);
    vi.mocked(saveDashboardLayout).mockClear();

    document.querySelector<HTMLButtonElement>('[aria-label="Move first clock down"]')?.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('.mndw-overlay-dialog__close')?.click();
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.mndw-order-overlay')).toBeNull();
    });
    expect(saveDashboardLayout).not.toHaveBeenCalled();

    arrangeButton(target)?.click();
    flushSync();

    expect([...document.querySelectorAll('.mndw-order-card__label')].map((label) => label.textContent)).toEqual([
      'first clock',
      'second clock',
    ]);
    expect(saveDashboardLayout).not.toHaveBeenCalled();

    void unmount(component);
  });
});
