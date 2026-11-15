// @vitest-environment happy-dom
import {defineMndwUi} from '@mndw/ui';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginInstance} from '@mndw/sdk';
import {flushSync, mount, unmount} from 'svelte';
import {PluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
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
import type {DashboardLayout} from './grid-layout-persistence.js';
import DashboardPage from './DashboardPage.svelte';

const PLUGIN_NAME = 'slow-storage-widget';
const TILE_ID = `widget-${PLUGIN_NAME}:1`;
const INSTANCE_ID = `${PLUGIN_NAME}:1`;
const GRID_LAYOUT_KEY = 'mndw:dashboard:grid-layout';
const STORAGE_PREFIX = `${PLUGIN_STORAGE_PREFIX}:${PLUGIN_NAME}:instance:${INSTANCE_ID}:`;
const INITIALIZER_STORAGE_KEY = `${STORAGE_PREFIX}settings`;
const UNMOUNT_STORAGE_KEY = `${STORAGE_PREFIX}unmount`;

const catalog = {
  registerPluginCatalogCell: vi.fn(),
  unregisterPluginCatalogCell: vi.fn(),
  clearPluginCatalogCells: vi.fn(),
};
const registry = new PluginRegistry({catalog});
const services = {...createHostServices(), registry};
const widgetEntry: WidgetListEntry = {
  name: PLUGIN_NAME,
  version: '0.1.0',
  label: 'Slow Storage Widget',
  entry: 'index.js',
  source: 'builtin',
  approval: 'approved',
  enabled: true,
  depsStatus: 'ready',
  backend: {routes: {}},
  type: 'widget',
  size: {w: 4, h: 3},
};

const mediaQuery = {
  matches: false,
  media: '(max-width: 720px)',
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(() => true),
} as unknown as MediaQueryList;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const needsResizeObserverStub = globalThis.ResizeObserver === undefined;
let target: HTMLElement;
let component: ReturnType<typeof mount> | undefined;
let pendingMount: Deferred<PluginInstance> | undefined;
let pendingReady: Promise<boolean> | undefined;
let instance: PluginInstance;

class ResizeObserverStub {
  public observe(): void {}
  public unobserve(): void {}
  public disconnect(): void {}
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value: T): void {
      resolvePromise(value);
    },
  };
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

function mountPage(mountTarget: HTMLElement): ReturnType<typeof mount> {
  const mountedComponent = mount(DashboardPage, {
    target: mountTarget,
    context: createHostServicesContext(services),
  });

  flushSync();

  return mountedComponent;
}

function prepareDashboard(): void {
  installGridWidth();
  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));

  if (needsResizeObserverStub) {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  }

  registry.clear();
  replacePluginLoadStates([widgetEntry]);
  setPluginLoadState(PLUGIN_NAME, 'loaded');
  setPluginLoadListOutcome('ok');
  createAppRouter(registry);

  pendingMount = deferred<PluginInstance>();
  instance = {
    unmount: () => {
      localStorage.setItem(UNMOUNT_STORAGE_KEY, 'unmounted');
    },
  };
  registry.register({
    entry: widgetEntry,
    module: {
      createInstance: () =>
        pendingMount?.promise.then((createdInstance) => {
          localStorage.setItem(INITIALIZER_STORAGE_KEY, 'initialized');

          return createdInstance;
        }) ?? Promise.resolve(instance),
    },
  });
  localStorage.setItem(
    GRID_LAYOUT_KEY,
    JSON.stringify(
      {
        tiles: [{id: TILE_ID, ['x']: 0, y: 0, w: 4, h: 3}],
        mobileOrder: [TILE_ID],
      } satisfies DashboardLayout,
    ),
  );
  localStorage.setItem(INITIALIZER_STORAGE_KEY, 'before-removal');

  target = document.createElement('div');
  document.body.appendChild(target);
  component = mountPage(target);
  pendingReady = getTileController(TILE_ID)?.handle?.whenReady();
}

async function cleanupDashboard(): Promise<void> {
  pendingMount?.resolve(instance);
  await pendingReady;

  if (component !== undefined) {
    await unmount(component);
    component = undefined;
  }

  pendingMount = undefined;
  pendingReady = undefined;
  localStorage.removeItem(INITIALIZER_STORAGE_KEY);
  localStorage.removeItem(UNMOUNT_STORAGE_KEY);
  localStorage.removeItem(GRID_LAYOUT_KEY);
  registry.clear();
  replacePluginLoadStates([]);
  setPluginLoadListOutcome('pending');
  restoreClientWidth();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
}

const removePendingTile = async (): Promise<void> => {
  expect(getTileController(TILE_ID)?.handle).toBeDefined();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('before-removal');

  const removeButton = target.querySelector<HTMLButtonElement>('.mndw-grid-tile__close');

  expect(removeButton).not.toBeNull();
  removeButton?.click();
  flushSync();

  expect(getTileController(TILE_ID)).toBeUndefined();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();

  pendingMount?.resolve(instance);
  await pendingReady;

  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();
  expect(localStorage.getItem(UNMOUNT_STORAGE_KEY)).toBeNull();
};

const reconcilePendingTileDeletion = async (): Promise<void> => {
  expect(getTileController(TILE_ID)?.handle).toBeDefined();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('before-removal');

  setPluginLoadListOutcome('failed');
  flushSync();
  replacePluginLoadStates([]);
  setPluginLoadListOutcome('ok');
  flushSync();

  expect(getTileController(TILE_ID)).toBeUndefined();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();

  pendingMount?.resolve(instance);
  await pendingReady;

  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();
  expect(localStorage.getItem(UNMOUNT_STORAGE_KEY)).toBeNull();
};

describe('DashboardPage pending mount storage cleanup', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  beforeEach(prepareDashboard);
  afterEach(cleanupDashboard);

  it('clears writes made when a pending instance settles after user removal', removePendingTile);
  it(
    'clears writes made when a pending instance settles after list reconciliation deletes it',
    reconcilePendingTileDeletion,
  );
});
