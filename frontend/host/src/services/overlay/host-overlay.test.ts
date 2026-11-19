// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync} from 'svelte';
import {type OverlayRuntime, createOverlayRuntime, createPluginOverlayService} from './overlay-manager.svelte.js';
import {openHostModal} from './host-overlay.js';
import HostOverlayProbe from './host-overlay-probe.svelte';

describe('openHostModal', () => {
  let runtime: OverlayRuntime;
  let service: ReturnType<typeof createPluginOverlayService>['service'];

  beforeEach(() => {
    runtime = createOverlayRuntime();
    service = createPluginOverlayService('@host', '@host', runtime).service;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts a modal and resolves its result when the component closes it', async () => {
    const onTeardown = vi.fn();
    const session = openHostModal(service, HostOverlayProbe, {title: 'Confirm', props: {onTeardown}});
    const closed = session.closed.then((event) => ({event, teardownCalls: onTeardown.mock.calls.length}));

    flushSync();

    const [layer] = runtime.store.layers;

    expect(layer).not.toBeNull();

    const approve = layer?.contentElement.querySelector<HTMLButtonElement>('.probe-approve');

    expect(approve).not.toBeNull();
    approve?.click();

    await expect(closed).resolves.toMatchObject({event: {result: 'approve'}, teardownCalls: 1});
    expect(runtime.store.layers).toEqual([]);
  });

  it('waits for teardown when the component closes during initialization', async () => {
    const onTeardown = vi.fn();
    const session = openHostModal(service, HostOverlayProbe, {
      title: 'Confirm',
      props: {closeImmediately: true, onTeardown},
    });
    const closed = session.closed.then((event) => ({event, teardownCalls: onTeardown.mock.calls.length}));

    await expect(closed).resolves.toMatchObject({event: {result: 'approve'}, teardownCalls: 1});
    expect(runtime.store.layers).toEqual([]);
  });

  it('can enable outside-click dismissal for host modals', () => {
    const session = openHostModal(service, HostOverlayProbe, {
      title: 'Dashboard',
      props: {onTeardown: vi.fn()},
      closeOnOutsideClick: true,
    });

    expect(runtime.store.layers[0]?.closeOnOutsideClick).toBe(true);

    session.close();
  });
});
