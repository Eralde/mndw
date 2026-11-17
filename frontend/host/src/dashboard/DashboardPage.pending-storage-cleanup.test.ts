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
import {ScopedPluginStorage} from '../services/storage.service.js';
import {toast} from '../services/toast/toast.svelte.js';
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
    unmount: () => {},
  };
  registry.register({
    entry: widgetEntry,
    module: {
      createInstance: (_container, context) =>
        pendingMount?.promise.then((createdInstance) => {
          void context.storage.set('settings', 'initialized');

          return {
            unmount: () => {
              void context.storage.set('unmount', 'unmounted');

              return createdInstance.unmount?.();
            },
          };
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
  toast.clear();
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
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('before-removal');

  pendingMount?.resolve(instance);
  await pendingReady;

  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('initialized');
  expect(localStorage.getItem(UNMOUNT_STORAGE_KEY)).toBe('unmounted');

  toast.dismissKey('dashboard-widget-removal');
  flushSync();
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

const pagehideFinalizesPendingRemoval = async (): Promise<void> => {
  pendingMount?.resolve(instance);
  await pendingReady;
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('initialized');

  const removeButton = target.querySelector<HTMLButtonElement>('.mndw-grid-tile__close');

  removeButton?.click();
  flushSync();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('initialized');

  window.dispatchEvent(new Event('pagehide'));
  flushSync();

  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();
  expect(toast.toasts.some((item) => item.key === 'dashboard-widget-removal')).toBe(false);

  const layout = JSON.parse(localStorage.getItem(GRID_LAYOUT_KEY) ?? 'null') as DashboardLayout | null;

  expect(layout?.tiles).toEqual([]);
};

const finalizedPendingMountCannotWriteIntoRestoredStorage = async (): Promise<void> => {
  const oldReady = pendingReady;

  expect(getTileController(TILE_ID)?.handle).toBeDefined();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('before-removal');

  target.querySelector<HTMLButtonElement>('.mndw-grid-tile__close')?.click();
  flushSync();
  expect(getTileController(TILE_ID)).toBeUndefined();

  toast.dismissKey('dashboard-widget-removal');
  flushSync();
  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();

  const restoredStorage = new ScopedPluginStorage(STORAGE_PREFIX);

  await restoredStorage.set('settings', 'restored');
  pendingMount?.resolve(instance);
  await oldReady;

  expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBe('restored');
  expect(localStorage.getItem(UNMOUNT_STORAGE_KEY)).toBeNull();
};

const finalizedRemovalCleansWritesFromLatePendingMount = async (): Promise<void> => {
  const oldReady = pendingReady;
  const storageWrite = vi.spyOn(localStorage, 'setItem');

  try {
    target.querySelector<HTMLButtonElement>('.mndw-grid-tile__close')?.click();
    flushSync();
    toast.dismissKey('dashboard-widget-removal');
    flushSync();

    expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();

    pendingMount?.resolve(instance);
    await oldReady;

    expect(storageWrite).toHaveBeenCalledWith(INITIALIZER_STORAGE_KEY, 'initialized');
    expect(storageWrite).toHaveBeenCalledWith(UNMOUNT_STORAGE_KEY, 'unmounted');
    expect(localStorage.getItem(INITIALIZER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(UNMOUNT_STORAGE_KEY)).toBeNull();
  } finally {
    storageWrite.mockRestore();
  }
};

describe('DashboardPage pending mount storage cleanup', () => {
  beforeAll(() => {
    defineMndwUi();
  });

  beforeEach(prepareDashboard);
  afterEach(cleanupDashboard);

  it('preserves writes until the removal toast is dismissed after pending mount settles', removePendingTile);
  it(
    'clears writes made when a pending instance settles after list reconciliation deletes it',
    reconcilePendingTileDeletion,
  );
  it('finalizes a pending removal on pagehide, including its Undo toast', pagehideFinalizesPendingRemoval);
  it(
    'keeps a late removed instance from overwriting restored instance storage',
    finalizedPendingMountCannotWriteIntoRestoredStorage,
  );
  it(
    'clears late writes after a pending removal is finalized',
    finalizedRemovalCleansWritesFromLatePendingMount,
  );
});
