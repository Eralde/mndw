// @vitest-environment happy-dom
/* eslint id-blacklist: 0 */
import {defineMndwUi} from '@mndw/ui';
import type {GridItemHTMLElement} from 'gridstack';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {PluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import {type WidgetTileHandle} from './widget-mount.js';
import DashboardPage from './DashboardPage.svelte';

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
let activeTarget: HTMLElement;

function widgetEntry(
  widget: (typeof PRIMARY_WIDGETS)[number],
): WidgetListEntry {
  return {
    version: '0.1.0',
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: {routes: {}},
    type: 'widget',
    ...widget,
  };
}

function registerPrimaryWidgets(): void {
  for (const widget of PRIMARY_WIDGETS) {
    registry.register({
      entry: widgetEntry(widget),
      module: {createInstance: vi.fn()},
    });
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
  target.querySelector<HTMLElement>('.mndw-dashboard__toolbar mndw-button')?.click();
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

    registry.clear();
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
});
