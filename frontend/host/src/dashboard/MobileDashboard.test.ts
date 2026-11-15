// @vitest-environment happy-dom
/* eslint id-blacklist: 0 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const retryPluginLoad = vi.hoisted(() => vi.fn());

vi.mock('../runtime/plugin-loader.js', () => ({retryPluginLoad}));

import {destroyAllTiles} from './tile-controller.js';
import MobileDashboard from './MobileDashboard.svelte';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {replacePluginLoadStates, setPluginLoadState} from '../runtime/plugin-load-state.svelte.js';

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

function seedFailedWidgets(names: string[]): void {
  replacePluginLoadStates(names.map(widgetEntry));

  for (const name of names) {
    setPluginLoadState(name, 'failed');
  }
}

function mountList(order: string[], onRemoveRequest = vi.fn()) {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(MobileDashboard, {
    target,
    props: {order, onRemoveRequest},
    context: createHostServicesContext(createHostServices()),
  });

  flushSync();

  return {component, target, onRemoveRequest};
}

beforeEach(() => {
  retryPluginLoad.mockReset();
  retryPluginLoad.mockResolvedValue(false);
  replacePluginLoadStates([]);
});

afterEach(() => {
  destroyAllTiles();
  replacePluginLoadStates([]);
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('MobileDashboard', () => {
  it('renders one flow tile per ordered id, appending each controller frame in order', () => {
    seedFailedWidgets(['clock', 'traffic']);

    const {component, target} = mountList(['widget-clock:1', 'widget-traffic:2']);

    const wrappers = [...target.querySelectorAll('.mndw-mobile-tile')];

    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]?.querySelector('.mndw-grid-tile__title')?.textContent).toBe('clock');
    expect(wrappers[1]?.querySelector('.mndw-grid-tile__title')?.textContent).toBe('traffic');
    expect(wrappers[0]?.querySelector('[role="alert"]')).not.toBeNull();
    expect(wrappers[1]?.querySelector('[role="alert"]')).not.toBeNull();

    void unmount(component);
  });

  it('keeps real controller retry and remove actions inside the mobile flow tile', async () => {
    seedFailedWidgets(['broken']);

    const id = 'widget-broken:3';
    const onRemoveRequest = vi.fn();
    const {component, target} = mountList([id], onRemoveRequest);

    const mobileTile = target.querySelector('.mndw-mobile-tile');
    const actions = mobileTile?.querySelectorAll<HTMLButtonElement>('[role="alert"] button');

    expect(actions?.[0]?.textContent).toBe('Retry');
    expect(actions?.[1]?.textContent).toBe('Remove');

    actions?.[0]?.click();
    actions?.[1]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(retryPluginLoad).toHaveBeenCalledWith('broken');
    expect(onRemoveRequest).toHaveBeenCalledWith(id);

    void unmount(component);
  });

  it('skips unparsable ids and null controllers without rendering an empty shell', () => {
    const {component, target} = mountList(['widget-gone:1', 'not-a-tile-id']);

    expect(target.querySelectorAll('.mndw-grid-tile')).toHaveLength(0);

    void unmount(component);
  });

  it('reuses existing controller frames (reparent, not rebuild)', () => {
    seedFailedWidgets(['clock']);

    const first = mountList(['widget-clock:1']);
    const frame = first.target.querySelector('.mndw-grid-tile');

    void unmount(first.component);

    const second = mountList(['widget-clock:1']);

    expect(second.target.querySelector('.mndw-grid-tile')).toBe(frame);

    void unmount(second.component);
  });
});
