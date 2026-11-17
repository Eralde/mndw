// @vitest-environment happy-dom
/* eslint id-blacklist: 0 */
import {defineMndwUi} from '@mndw/ui';
import {type GridItemHTMLElement, GridStack} from 'gridstack';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {PluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {
  replacePluginLoadStates,
  setPluginLoadListOutcome,
  setPluginLoadState,
} from '../runtime/plugin-load-state.svelte.js';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import {createAppRouter} from '../router/create-app-router.js';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {getTileController} from './tile-controller.js';
import {type WidgetTileHandle} from './widget-mount.js';
import DashboardPage from './DashboardPage.svelte';
import OverlayHost from '../components/overlay/OverlayHost.svelte';
import {defaultOverlayRuntime} from '../services/overlay/overlay-manager.svelte.js';
import {toast} from '../services/toast/toast.svelte.js';

const disposeWidget = vi.hoisted(() => vi.fn());
const getNextInstanceId = vi.hoisted(() => vi.fn((name: string) => `${name}:1`));
const raiseInstanceCounter = vi.hoisted(() => vi.fn());

vi.mock('./widget-mount.js', () => ({
  mountWidgetTile: vi.fn((): WidgetTileHandle => ({
    getMounted: () => null,
    whenReady: () => Promise.resolve(true),
    dispose: disposeWidget,
  })),
}));

vi.mock('./widget-counter.js', () => ({
  getNextInstanceId,
  raiseInstanceCounter,
}));

const GRID_LAYOUT_KEY = 'mndw:dashboard:grid-layout';

const PRIMARY_WIDGETS = [
  {name: 'sample-widget', label: 'Sample Widget', size: {w: 4, h: 3, minW: 3, minH: 2}},
  {name: 'clients-widget', label: 'Clients', size: {w: 6, h: 4, minW: 4, minH: 3}},
  {name: 'clock-widget', label: 'Clock', size: {w: 3, h: 2}},
  {name: 'dns-lookup-widget', label: 'DNS Lookup', size: {w: 4, h: 4, minW: 3, minH: 3}},
  {name: 'device-info-widget', label: 'Device Info', size: {w: 4, h: 8, minW: 4, minH: 8}},
  {name: 'tx-rx-chart-widget', label: 'TX/RX Traffic', size: {w: 6, h: 4, minW: 4, minH: 4}},
] as const;

const expectedIds = new Set(PRIMARY_WIDGETS.map(({name}) => `widget-${name}:1`));
const expectedLabels = new Set(PRIMARY_WIDGETS.map(({label}) => label));

const catalog = {
  registerPluginCatalogCell: vi.fn(),
  unregisterPluginCatalogCell: vi.fn(),
  clearPluginCatalogCells: vi.fn(),
};
const registry = new PluginRegistry({catalog});
const services = {...createHostServices(), registry};

let mobileListener: ((event: MediaQueryListEvent) => void) | undefined;
let mobileMatches = false;

const mediaQuery = {
  get matches(): boolean {
    return mobileMatches;
  },
  media: '(max-width: 720px)',
  onchange: null,
  addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
    mobileListener = listener;
  }),
  removeEventListener: vi.fn(() => {
    mobileListener = undefined;
  }),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(() => true),
} as unknown as MediaQueryList;

const needsResizeObserverStub = globalThis.ResizeObserver === undefined;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

class ResizeObserverStub {
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
}

interface StoredTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

let activeComponent: ReturnType<typeof mount> | undefined;
let activeOverlayHost: ReturnType<typeof mount> | undefined;
let activeTarget: HTMLElement;

function widgetEntry(
  widget: {name: string; label: string; size: {w: number; h: number; minW?: number; minH?: number}},
  options: {enabled?: boolean} = {},
): WidgetListEntry {
  return {
    version: '0.1.0',
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: options.enabled ?? true,
    depsStatus: 'ready',
    backend: {routes: {}},
    type: 'widget',
    ...widget,
  };
}

function registerWidget(widget: Parameters<typeof widgetEntry>[0]): void {
  registry.register({
    entry: widgetEntry(widget),
    module: {createInstance: vi.fn()},
  });
}

function registerPrimaryWidgets(): void {
  for (const widget of PRIMARY_WIDGETS) {
    registerWidget(widget);
  }
}

function installGridWidth(): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains('grid-stack') ? 1200 : 0;
    },
  });
}

function restoreClientWidth(): void {
  if (originalClientWidth === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  } else {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
}

function setMobile(matches: boolean): void {
  mobileMatches = matches;
  mobileListener?.({matches} as MediaQueryListEvent);
  flushSync();
}

function addWidgetByLabel(target: HTMLElement, label: string): void {
  // Empty dashboard: the CTA lives in the empty state; once tiles exist, the toolbar.
  const addButton = target.querySelector<HTMLElement>('.mndw-dashboard__toolbar mndw-button')
    ?? target.querySelector<HTMLElement>('.mndw-empty-state mndw-button');

  addButton?.click();
  flushSync();

  const button = [...document.body.querySelectorAll<HTMLElement>('.mndw-floating-panel mndw-button')]
    .find((candidate) => candidate.textContent?.trim() === label);

  expect(button, `missing add button for ${label}`).toBeDefined();
  button?.click();
  flushSync();
}

function readStoredTiles(): StoredTile[] {
  const raw = localStorage.getItem(GRID_LAYOUT_KEY);
  const parsed = JSON.parse(raw ?? '{"tiles":[]}') as {tiles: StoredTile[]};

  return parsed.tiles;
}

function readStoredIds(): string[] {
  return readStoredTiles().map((tile) => tile.id);
}

function readDesktopIds(target: HTMLElement): string[] {
  return [...target.querySelectorAll<GridItemHTMLElement>('.grid-stack-item')]
    .map((item) => item.gridstackNode?.id)
    .filter((id): id is string => typeof id === 'string');
}

function getDesktopGrid(target: HTMLElement): ReturnType<typeof GridStack.init> {
  const element = target.querySelector<HTMLElement>('.grid-stack');

  if (element === null) {
    throw new Error('expected the desktop grid to be mounted');
  }

  return GridStack.init({}, element);
}

function storedTile(id: string, x: number, y: number): StoredTile {
  return {id, x, y, w: 4, h: 3};
}

function seedInstanceStorage(pluginName: string, instanceId: string): string {
  const key = `${PLUGIN_STORAGE_PREFIX}:${pluginName}:instance:${instanceId}:settings`;

  localStorage.setItem(key, `settings for ${pluginName}`);

  return key;
}

function readMobileLabels(target: HTMLElement): string[] {
  return [...target.querySelectorAll<HTMLElement>('.mndw-mobile-tile .mndw-grid-tile__title')]
    .map((title) => title.textContent?.trim() ?? '');
}

function assertDesktopIdentity(target: HTMLElement): void {
  const renderedIds = readDesktopIds(target);
  const storedIds = readStoredIds();

  expect(new Set(storedIds)).toEqual(expectedIds);
  expect(storedIds).toHaveLength(expectedIds.size);
  expect(new Set(renderedIds)).toEqual(expectedIds);
  expect(renderedIds).toHaveLength(expectedIds.size);
  expect(new Set(storedIds)).toEqual(new Set(renderedIds));
}

function assertGeometry(): void {
  for (const tile of readStoredTiles()) {
    expect(Number.isInteger(tile.x) && tile.x >= 0).toBe(true);
    expect(Number.isInteger(tile.y) && tile.y >= 0).toBe(true);
    expect(Number.isInteger(tile.w) && tile.w > 0).toBe(true);
    expect(Number.isInteger(tile.h) && tile.h > 0).toBe(true);
  }
}

function mountPage(): void {
  activeComponent = mount(DashboardPage, {
    target: activeTarget,
    context: createHostServicesContext(services),
  });
  activeOverlayHost = mount(OverlayHost, {target: document.body});

  flushSync();
}

async function remountPage(): Promise<void> {
  if (activeComponent === undefined) {
    throw new Error('Cannot remount an unmounted dashboard page');
  }

  await unmount(activeComponent);
  flushSync();
  mountPage();
}

async function waitForPersist(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 550));
  flushSync();
}

function addAllWidgets(): void {
  mountPage();

  for (const widget of PRIMARY_WIDGETS) {
    addWidgetByLabel(activeTarget, widget.label);
  }
}

describe('DashboardPage real GridStack persistence characterization', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  beforeEach(() => {
    installGridWidth();
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));

    if (needsResizeObserverStub) {
      vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    }

    registry.clear();
    registerPrimaryWidgets();
    replacePluginLoadStates(PRIMARY_WIDGETS.map((widget) => widgetEntry(widget)));

    for (const widget of PRIMARY_WIDGETS) {
      setPluginLoadState(widget.name, 'loaded');
    }

    setPluginLoadListOutcome('ok');
    createAppRouter(registry);
    localStorage.removeItem(GRID_LAYOUT_KEY);
    replaceDepsStatuses([]);
    mobileMatches = false;
    mobileListener = undefined;
    getNextInstanceId.mockClear();
    raiseInstanceCounter.mockClear();
    disposeWidget.mockClear();

    activeTarget = document.createElement('div');
    document.body.appendChild(activeTarget);
  });

  afterEach(async () => {
    if (activeComponent !== undefined) {
      await unmount(activeComponent);
      activeComponent = undefined;
    }

    for (const layer of [...defaultOverlayRuntime.store.layers]) {
      layer.close();
    }

    await vi.waitFor(() => {
      flushSync();
      expect(defaultOverlayRuntime.store.layers).toHaveLength(0);
    });

    if (activeOverlayHost !== undefined) {
      await unmount(activeOverlayHost);
      activeOverlayHost = undefined;
    }

    registry.clear();
    replacePluginLoadStates([]);
    setPluginLoadListOutcome('pending');
    restoreClientWidth();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  afterAll(() => {
    registry.clear();
  });

  it('preserves every intentionally added widget in rendered and durable identity', () => {
    addAllWidgets();

    assertDesktopIdentity(activeTarget);
  });

  it('preserves every added widget across immediate navigation teardown and remount', async () => {
    addAllWidgets();

    await remountPage();

    assertDesktopIdentity(activeTarget);
  });

  it('preserves every added widget after debounce completion and remount', async () => {
    addAllWidgets();
    await waitForPersist();
    await remountPage();

    assertDesktopIdentity(activeTarget);
  });

  it('preserves durable identity and labels through desktop-to-mobile transition', () => {
    addAllWidgets();

    setMobile(true);

    expect(new Set(readStoredIds())).toEqual(expectedIds);
    expect(new Set(readMobileLabels(activeTarget))).toEqual(expectedLabels);
    expect(readMobileLabels(activeTarget)).toHaveLength(expectedLabels.size);
  });

  it('preserves identity and geometry through mobile-to-desktop transition', () => {
    addAllWidgets();

    setMobile(true);

    setMobile(false);

    assertDesktopIdentity(activeTarget);
    assertGeometry();
  });

  it('restores every widget from the exact stored JSON', async () => {
    addAllWidgets();

    const stored = localStorage.getItem(GRID_LAYOUT_KEY);

    expect(stored).not.toBeNull();
    await remountPage();
    localStorage.setItem(GRID_LAYOUT_KEY, stored ?? '');

    assertDesktopIdentity(activeTarget);
  });

  it('keeps dormant geometry and mobile slot through list recovery after a pending grid change', async () => {
    const clock = PRIMARY_WIDGETS[2];
    const dormant = {name: 'dormant-widget', label: 'Dormant', size: {w: 4, h: 3}};
    const clockTile = storedTile('widget-clock-widget:1', 0, 0);
    const dormantTile = storedTile('widget-dormant-widget:1', 0, 4);
    const originalLayout = {
      tiles: [clockTile, dormantTile],
      mobileOrder: [dormantTile.id, clockTile.id],
    };

    registerWidget(dormant);
    replacePluginLoadStates([widgetEntry(clock), widgetEntry(dormant)]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadState(dormant.name, 'loaded');
    localStorage.setItem(GRID_LAYOUT_KEY, JSON.stringify(originalLayout));
    mountPage();

    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    setPluginLoadListOutcome('pending');
    flushSync();

    const grid = getDesktopGrid(activeTarget);
    const clockItem = grid.getGridItems().find((item) => item.gridstackNode?.id === clockTile.id);

    if (clockItem === undefined) {
      throw new Error('expected clock widget to be restored');
    }

    grid.update(clockItem, {x: 1});
    flushSync();

    expect(localStorage.getItem(GRID_LAYOUT_KEY)).toBe(JSON.stringify(originalLayout));
    expect(setItemSpy.mock.calls.filter(([key]) => key === GRID_LAYOUT_KEY)).toHaveLength(0);

    replacePluginLoadStates([
      widgetEntry(clock),
      widgetEntry(dormant, {enabled: false}),
    ]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadListOutcome('ok');
    flushSync();
    await waitForPersist();

    expect(readDesktopIds(activeTarget)).toEqual([clockTile.id]);
    expect(readStoredTiles()).toEqual(originalLayout.tiles);
    expect(readStoredIds()).toEqual([clockTile.id, dormantTile.id]);

    const persistedLayout = JSON.parse(localStorage.getItem(GRID_LAYOUT_KEY) ?? '') as {mobileOrder: string[]};

    expect(persistedLayout.mobileOrder).toEqual(originalLayout.mobileOrder);
    expect(setItemSpy.mock.calls.filter(([key]) => key === GRID_LAYOUT_KEY)).toHaveLength(1);
  });

  it('removes deleted and disabled controllers on recovery and keeps only dormant storage after later grid changes', async () => {
    const clock = PRIMARY_WIDGETS[2];
    const dormant = {name: 'dormant-widget', label: 'Dormant', size: {w: 4, h: 3}};
    const deleted = {name: 'deleted-widget', label: 'Deleted', size: {w: 4, h: 3}};
    const clockTile = storedTile('widget-clock-widget:1', 0, 0);
    const dormantTile = storedTile('widget-dormant-widget:1', 0, 4);
    const deletedTile = storedTile('widget-deleted-widget:1', 0, 8);

    registerWidget(dormant);
    registerWidget(deleted);
    replacePluginLoadStates([
      widgetEntry(clock),
      widgetEntry(dormant),
      widgetEntry(deleted),
    ]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadState(dormant.name, 'loaded');
    setPluginLoadState(deleted.name, 'loaded');
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [clockTile, dormantTile, deletedTile],
        mobileOrder: [clockTile.id, dormantTile.id, deletedTile.id],
      }),
    );
    mountPage();

    expect(readDesktopIds(activeTarget)).toEqual([clockTile.id, dormantTile.id, deletedTile.id]);
    expect(getTileController(dormantTile.id)).toBeDefined();
    expect(getTileController(deletedTile.id)).toBeDefined();

    setPluginLoadListOutcome('failed');
    flushSync();
    replacePluginLoadStates([
      widgetEntry(clock),
      widgetEntry(dormant, {enabled: false}),
    ]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(readDesktopIds(activeTarget)).toEqual([clockTile.id]);
    expect(getTileController(dormantTile.id)).toBeUndefined();
    expect(getTileController(deletedTile.id)).toBeUndefined();
    expect(disposeWidget).toHaveBeenCalledTimes(2);
    expect(disposeWidget).toHaveBeenNthCalledWith(1, {
      clearStorage: false,
      closeReason: 'plugin-unmount',
    });
    expect(disposeWidget).toHaveBeenNthCalledWith(2, {
      clearStorage: true,
      closeReason: 'plugin-unmount',
    });
    expect(readStoredIds()).toEqual([clockTile.id, dormantTile.id]);
    expect(readStoredTiles().find((tile) => tile.id === dormantTile.id)).toEqual(dormantTile);

    const grid = getDesktopGrid(activeTarget);
    const clockItem = grid.getGridItems().find((item) => item.gridstackNode?.id === clockTile.id);

    if (clockItem === undefined) {
      throw new Error('expected clock widget to remain in the grid');
    }

    grid.update(clockItem, {x: 1});
    flushSync();
    await waitForPersist();

    expect(readDesktopIds(activeTarget)).toEqual([clockTile.id]);
    expect(readStoredIds()).toEqual([clockTile.id, dormantTile.id]);
    expect(readStoredTiles().find((tile) => tile.id === dormantTile.id)).toEqual(dormantTile);
  });

  it('clears storage when previously loaded and initially dormant tiles are later deleted', () => {
    const clock = PRIMARY_WIDGETS[2];
    const previouslyLoaded = {name: 'previously-loaded-widget', label: 'Previously Loaded', size: {w: 4, h: 3}};
    const initiallyDormant = {name: 'initially-dormant-widget', label: 'Initially Dormant', size: {w: 4, h: 3}};
    const clockTile = storedTile('widget-clock-widget:1', 0, 0);
    const loadedTile = storedTile('widget-previously-loaded-widget:1', 0, 4);
    const dormantTile = storedTile('widget-initially-dormant-widget:1', 0, 8);
    const loadedStorageKey = seedInstanceStorage(previouslyLoaded.name, 'previously-loaded-widget:1');
    const dormantStorageKey = seedInstanceStorage(initiallyDormant.name, 'initially-dormant-widget:1');

    registerWidget(previouslyLoaded);
    registerWidget(initiallyDormant);
    replacePluginLoadStates([
      widgetEntry(clock),
      widgetEntry(previouslyLoaded),
      widgetEntry(initiallyDormant, {enabled: false}),
    ]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadState(previouslyLoaded.name, 'loaded');
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({
        tiles: [clockTile, loadedTile, dormantTile],
        mobileOrder: [clockTile.id, loadedTile.id, dormantTile.id],
      }),
    );
    mountPage();

    expect(getTileController(dormantTile.id)).toBeUndefined();
    expect(localStorage.getItem(loadedStorageKey)).toBe('settings for previously-loaded-widget');
    expect(localStorage.getItem(dormantStorageKey)).toBe('settings for initially-dormant-widget');

    setPluginLoadListOutcome('failed');
    flushSync();
    replacePluginLoadStates([
      widgetEntry(clock),
      widgetEntry(previouslyLoaded, {enabled: false}),
      widgetEntry(initiallyDormant, {enabled: false}),
    ]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(localStorage.getItem(loadedStorageKey)).toBe('settings for previously-loaded-widget');
    expect(localStorage.getItem(dormantStorageKey)).toBe('settings for initially-dormant-widget');

    setPluginLoadListOutcome('failed');
    flushSync();
    replacePluginLoadStates([widgetEntry(clock)]);
    setPluginLoadState(clock.name, 'loaded');
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(localStorage.getItem(loadedStorageKey)).toBeNull();
    expect(localStorage.getItem(dormantStorageKey)).toBeNull();
    expect(readStoredIds()).toEqual([clockTile.id]);
  });

  it('clears storage when the user removes a failed-load placeholder', () => {
    const pluginName = 'failed-placeholder-widget';
    const tile = storedTile(`widget-${pluginName}:1`, 0, 0);
    const storageKey = seedInstanceStorage(pluginName, `${pluginName}:1`);

    replacePluginLoadStates([widgetEntry({name: pluginName, label: 'Failed Placeholder', size: {w: 4, h: 3}})]);
    setPluginLoadState(pluginName, 'failed');
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({tiles: [tile], mobileOrder: [tile.id]}),
    );
    mountPage();

    expect(getTileController(tile.id)?.body.querySelector('.mndw-grid-tile__notice--plugin-load-failed'))
      .not.toBeNull();
    expect(localStorage.getItem(storageKey)).toBe('settings for failed-placeholder-widget');

    activeTarget.querySelector<HTMLButtonElement>('.mndw-grid-tile__remove-failed')?.click();
    flushSync();

    expect(localStorage.getItem(storageKey)).toBe('settings for failed-placeholder-widget');
    expect(readStoredIds()).toEqual([]);
    expect(getTileController(tile.id)).toBeUndefined();

    toast.dismissKey('dashboard-widget-removal');
    flushSync();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('clears storage when a deleted plugin has a dependency placeholder', () => {
    const plugin = {name: 'dependency-placeholder-widget', label: 'Dependency Placeholder', size: {w: 4, h: 3}};
    const tile = storedTile(`widget-${plugin.name}:1`, 0, 0);
    const storageKey = seedInstanceStorage(plugin.name, `${plugin.name}:1`);

    registerWidget(plugin);
    replacePluginLoadStates([widgetEntry(plugin)]);
    setPluginLoadState(plugin.name, 'loaded');
    replaceDepsStatuses([{name: plugin.name, depsStatus: 'installing'}]);
    localStorage.setItem(
      GRID_LAYOUT_KEY,
      JSON.stringify({tiles: [tile], mobileOrder: [tile.id]}),
    );
    mountPage();

    expect(getTileController(tile.id)?.body.querySelector('.mndw-grid-tile__notice--installing'))
      .not.toBeNull();
    expect(localStorage.getItem(storageKey)).toBe('settings for dependency-placeholder-widget');

    setPluginLoadListOutcome('failed');
    flushSync();
    replacePluginLoadStates([]);
    setPluginLoadListOutcome('ok');
    flushSync();

    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(readStoredIds()).toEqual([]);
    expect(getTileController(tile.id)).toBeUndefined();
  });
});
