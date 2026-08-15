/* eslint id-blacklist: 0 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const resizeToContent = vi.hoisted(() => vi.fn());
const dispose = vi.hoisted(() => vi.fn());
const onResize = vi.hoisted(() => vi.fn());
const controllers = vi.hoisted(() => new Map<string, {id: string; frame: HTMLElement; body: HTMLElement}>());
const mountWidgetTile = vi.hoisted(() => vi.fn());
const fakeGrid = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  save: vi.fn(() => []),
  addWidget: vi.fn((options: {id: string}) => {
    const item = document.createElement('div');
    const content = document.createElement('div');

    item.className = 'grid-stack-item';
    item.dataset.id = options.id;
    content.className = 'grid-stack-item-content';
    item.appendChild(content);
    document.body.appendChild(item);

    return item;
  }),
  removeWidget: vi.fn(),
  prepareDragDrop: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('gridstack', () => ({
  GridStack: {init: vi.fn(() => fakeGrid)},
}));

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {get: vi.fn()},
}));

vi.mock('../state/deps-status.svelte.js', () => ({
  getDepsStatus: vi.fn(() => 'ready'),
}));

vi.mock('./widget-mount.js', () => ({mountWidgetTile}));

vi.mock('./tile-controller.js', () => ({
  ensureTileController: vi.fn((_services: unknown, _registry: unknown, _pluginName: string, instanceId: string) => {
    const id = `widget-${instanceId}`;
    let controller = controllers.get(id);

    if (controller === undefined) {
      const frame = document.createElement('div');
      const body = document.createElement('div');

      frame.className = 'mndw-grid-tile';
      body.className = 'mndw-grid-tile__body';
      frame.appendChild(body);
      controller = {id, frame, body};
      controllers.set(id, controller);
      mountWidgetTile(body, {}, {});
    }

    return controller;
  }),
  getTileController: vi.fn((id: string) => controllers.get(id)),
  removeTileController: vi.fn(),
}));

import {pluginRegistry} from '../runtime/plugin-registry.js';
import {localeService} from '../services/locale.service.js';
import {paletteService} from '../services/palette.service.js';
import {defaultHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import {addWidgetTile} from './grid-dashboard-setup.js';
import DashboardGrid from './DashboardGrid.svelte';
import MobileDashboard from './MobileDashboard.svelte';
import {getTileController, removeTileController} from './tile-controller.js';

const pluginContextServices = {locale: localeService, palette: paletteService};

const plugin = {
  entry: {
    name: 'traffic',
    version: '1.0.0',
    label: 'Traffic',
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: {routes: {}},
    type: 'widget',
    size: {w: 4, h: 3},
  },
  module: {createInstance: vi.fn(() => ({unmount: vi.fn(), onResize}))},
};

describe('dashboard renderer transition', () => {
  beforeEach(() => {
    controllers.clear();
    vi.mocked(pluginRegistry).get.mockReturnValue(plugin as never);
    mountWidgetTile.mockReset();
    mountWidgetTile.mockReturnValue({
      getMounted: vi.fn(() => ({instance: {onResize}})),
      whenReady: vi.fn(() => Promise.resolve(true)),
      dispose,
    });
    dispose.mockReset();
    onResize.mockReset();
    resizeToContent.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('moves the same live frame from GridStack into mobile flow', () => {
    const desktopTarget = document.createElement('div');
    const mobileTarget = document.createElement('div');

    document.body.append(desktopTarget, mobileTarget);

    const desktop = mount(DashboardGrid, {
      target: desktopTarget,
      props: {
        onGridReady: vi.fn(),
        onGridDestroyed: vi.fn(),
        onWidgetRemoved: vi.fn(),
        onLayoutChanged: vi.fn(),
        onWidgetResized: vi.fn(),
      },
    });
    const id = addWidgetTile(pluginContextServices, pluginRegistry, fakeGrid as never, 'traffic', vi.fn());

    if (id === null) {
      throw new Error('addWidgetTile unexpectedly returned null');
    }

    const frame = vi.mocked(getTileController)(id)?.frame;

    expect(frame).toBeDefined();
    expect(mountWidgetTile).toHaveBeenCalledTimes(1);

    void unmount(desktop);

    const mobile = mount(MobileDashboard, {
      target: mobileTarget,
      props: {order: [id], onRemoveRequest: vi.fn()},
      context: createHostServicesContext(defaultHostServices()),
    });

    flushSync();

    expect(mobileTarget.querySelector('.mndw-mobile-tile')?.contains(frame ?? null)).toBe(true);
    expect(mountWidgetTile).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();

    void unmount(mobile);
    vi.mocked(removeTileController)(id);
    desktopTarget.remove();
    mobileTarget.remove();
  });

  it('keeps asynchronously-added body content in mobile flow without GridStack sizing', async () => {
    const mobileTarget = document.createElement('div');

    document.body.appendChild(mobileTarget);

    const mobile = mount(MobileDashboard, {
      target: mobileTarget,
      props: {order: ['widget-traffic:1'], onRemoveRequest: vi.fn()},
      context: createHostServicesContext(defaultHostServices()),
    });

    flushSync();

    const body = mobileTarget.querySelector<HTMLElement>('.mndw-grid-tile__body');
    const content = document.createElement('div');

    content.textContent = 'loaded later';
    content.style.height = '240px';
    await Promise.resolve();
    body?.appendChild(content);

    expect(body?.textContent).toContain('loaded later');
    expect(resizeToContent).not.toHaveBeenCalled();

    void unmount(mobile);
    mobileTarget.remove();
  });
});
