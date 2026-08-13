import {afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync} from 'svelte';
import {defaultOverlayRuntime} from './overlay-manager.svelte.js';
import {openHostModal} from './host-overlay.js';
import HostOverlayProbe from './host-overlay-probe.svelte';

describe('openHostModal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts a modal and resolves its result when the component closes it', async () => {
    const onTeardown = vi.fn();
    const session = openHostModal(HostOverlayProbe, {title: 'Confirm', props: {onTeardown}});
    const closed = session.closed.then((event) => ({event, teardownCalls: onTeardown.mock.calls.length}));

    flushSync();

    const [layer] = defaultOverlayRuntime.store.layers;

    expect(layer).not.toBeNull();
    const approve = layer?.contentElement.querySelector<HTMLButtonElement>('.probe-approve');

    expect(approve).not.toBeNull();
    approve?.click();

    await expect(closed).resolves.toMatchObject({event: {result: 'approve'}, teardownCalls: 1});
    expect(defaultOverlayRuntime.store.layers).toEqual([]);
  });

  it('waits for teardown when the component closes during initialization', async () => {
    const onTeardown = vi.fn();
    const session = openHostModal(HostOverlayProbe, {
      title: 'Confirm',
      props: {closeImmediately: true, onTeardown},
    });
    const closed = session.closed.then((event) => ({event, teardownCalls: onTeardown.mock.calls.length}));

    await expect(closed).resolves.toMatchObject({event: {result: 'approve'}, teardownCalls: 1});
    expect(defaultOverlayRuntime.store.layers).toEqual([]);
  });
});
