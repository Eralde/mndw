/* eslint id-blacklist: 0 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

const controllers = vi.hoisted(() => new Map<string, {frame: HTMLElement}>());

vi.mock('./tile-controller.js', () => ({
  ensureTileController: vi.fn((_pluginName: string, instanceId: string) => {
    const id = `widget-${instanceId}`;

    if (!controllers.has(id)) {
      const frame = document.createElement('div');

      frame.className = 'mndw-grid-tile';
      frame.dataset.tile = id;
      controllers.set(id, {frame});
    }

    return {id, frame: controllers.get(id)?.frame};
  }),
}));

import {ensureTileController} from './tile-controller.js';
import MobileDashboard from './MobileDashboard.svelte';

function mountList(order: string[], onRemoveRequest = vi.fn()) {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const component = mount(MobileDashboard, {target, props: {order, onRemoveRequest}});

  flushSync();

  return {component, target, onRemoveRequest};
}

describe('MobileDashboard', () => {
  afterEach(() => {
    controllers.clear();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('renders one flow tile per ordered id, appending each controller frame in order', () => {
    const {component, target} = mountList(['widget-clock:1', 'widget-traffic:2']);

    const wrappers = [...target.querySelectorAll('.mndw-mobile-tile')];

    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]?.querySelector('.mndw-grid-tile')?.getAttribute('data-tile')).toBe('widget-clock:1');
    expect(wrappers[1]?.querySelector('.mndw-grid-tile')?.getAttribute('data-tile')).toBe('widget-traffic:2');
    expect(ensureTileController).toHaveBeenCalledWith('clock', 'clock:1', expect.any(Function));

    void unmount(component);
  });

  it('skips unparsable ids and null controllers without rendering an empty shell', () => {
    vi.mocked(ensureTileController).mockReturnValueOnce(null);

    const {component, target} = mountList(['widget-gone:1', 'not-a-tile-id']);

    expect(target.querySelectorAll('.mndw-grid-tile')).toHaveLength(0);

    void unmount(component);
  });

  it('reuses existing controller frames (reparent, not rebuild)', () => {
    const first = mountList(['widget-clock:1']);
    const frame = first.target.querySelector('.mndw-grid-tile');

    void unmount(first.component);

    const second = mountList(['widget-clock:1']);

    expect(second.target.querySelector('.mndw-grid-tile')).toBe(frame);

    void unmount(second.component);
  });
});
