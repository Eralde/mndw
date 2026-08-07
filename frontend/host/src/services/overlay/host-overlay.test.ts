import {afterEach, describe, expect, it, vi} from 'vitest';
import {flushSync} from 'svelte';
import {overlayStore, resetOverlayStateForTests} from './overlay-manager.svelte.js';
import {openHostModal} from './host-overlay.js';
import HostOverlayProbe from './host-overlay-probe.svelte';

describe('openHostModal', () => {
  afterEach(() => {
    resetOverlayStateForTests();
    document.body.innerHTML = '';
  });

  it('mounts a modal and resolves its result when the component closes it', async () => {
    const onTeardown = vi.fn();
    const session = openHostModal(HostOverlayProbe, {title: 'Confirm', props: {onTeardown}});
    const closed = session.closed.then((event) => ({event, teardownCalls: onTeardown.mock.calls.length}));

    flushSync();

    expect(overlayStore.layers).toHaveLength(1);
    expect(overlayStore.layers[0]?.kind).toBe('modal');

    const approve = overlayStore.layers[0]?.contentElement.querySelector<HTMLButtonElement>('.probe-approve');

    expect(approve).not.toBeNull();
    approve?.click();

    await expect(closed).resolves.toMatchObject({event: {result: 'approve'}, teardownCalls: 1});
    expect(overlayStore.layers).toEqual([]);
  });

  it('waits for teardown when the component closes during initialization', async () => {
    const onTeardown = vi.fn();
    const session = openHostModal(HostOverlayProbe, {
      title: 'Confirm',
      props: {closeImmediately: true, onTeardown},
    });
    const closed = session.closed.then((event) => ({event, teardownCalls: onTeardown.mock.calls.length}));

    await expect(closed).resolves.toMatchObject({event: {result: 'approve'}, teardownCalls: 1});
    expect(overlayStore.layers).toEqual([]);
  });
});
