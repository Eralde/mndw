// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';
import {defineMndwUi} from '@mndw/ui';
import {type OverlayRuntime, createOverlayRuntime, createPluginOverlayService} from './overlay-manager.svelte.js';
import {openHostModal} from './host-overlay.js';
import OverlayHost from '../../components/overlay/OverlayHost.svelte';
import HostOverlayProbe from './host-overlay-probe.svelte';

let runtime: OverlayRuntime;
let service: ReturnType<typeof createPluginOverlayService>['service'];

beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  runtime = createOverlayRuntime();
  service = createPluginOverlayService('@host', '@host', runtime).service;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('openHostModal', () => {
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

describe('confirmHost accessibility and result', () => {
  it('renders confirm as a named alertdialog and resolves true only from its confirm button', async () => {
    const root = document.createElement('div');

    document.body.appendChild(root);

    const host = mount(OverlayHost, {target: root, props: {runtime}});
    const previousFocus = document.createElement('button');

    document.body.appendChild(previousFocus);
    previousFocus.focus();

    const {service: pluginOverlay} = createPluginOverlayService('demo', 'demo:1', runtime);
    const answer = pluginOverlay.confirm({title: 'Delete entry?', message: 'This cannot be undone.'});

    flushSync();

    const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
    const titleId = dialog?.getAttribute('aria-labelledby');
    const descriptionId = dialog?.getAttribute('aria-describedby');
    const confirmButton = [...(root.querySelectorAll<HTMLElement>('mndw-button'))]
      .find((button) => button.textContent?.trim() === 'Confirm');

    expect(dialog).not.toBeNull();
    expect(titleId === null ? null : root.querySelector(`#${titleId}`)?.textContent?.trim()).toBe('Delete entry?');
    expect(descriptionId === null ? null : root.querySelector(`#${descriptionId}`)?.textContent?.trim())
      .toBe('This cannot be undone.');
    expect(root.querySelectorAll('mndw-button').length).toBe(2);
    confirmButton?.click();

    await expect(answer).resolves.toBe(true);
    expect(document.activeElement).toBe(previousFocus);
    await unmount(host);
    root.remove();
  });
});

describe('confirmHost dismissal paths', () => {
  it('resolves false for Cancel, Escape, outside click, closeAll, unmount, and navigation', async () => {
    const root = document.createElement('div');

    document.body.appendChild(root);

    const host = mount(OverlayHost, {target: root, props: {runtime}});
    const {service: pluginOverlay, dispose} = createPluginOverlayService('demo', 'demo:1', runtime);

    const cancelAnswer = pluginOverlay.confirm({title: 'Cancel?'});

    flushSync();
    root.querySelectorAll<HTMLElement>('mndw-button')[0]?.click();
    await expect(cancelAnswer).resolves.toBe(false);

    const escapeAnswer = pluginOverlay.confirm({title: 'Escape?'});

    flushSync();
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await expect(escapeAnswer).resolves.toBe(false);

    const outsideAnswer = pluginOverlay.confirm({title: 'Outside?'});

    flushSync();
    window.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    await expect(outsideAnswer).resolves.toBe(false);

    const closeAllAnswer = pluginOverlay.confirm({title: 'Close all?'});

    flushSync();
    pluginOverlay.closeAll();
    await expect(closeAllAnswer).resolves.toBe(false);

    const unmountAnswer = pluginOverlay.confirm({title: 'Unmount?'});

    flushSync();
    dispose('plugin-unmount');
    await expect(unmountAnswer).resolves.toBe(false);

    const {service: navigatingOverlay, dispose: navigate} = createPluginOverlayService('other', 'other:1', runtime);
    const navigationAnswer = navigatingOverlay.confirm({title: 'Navigate?'});

    flushSync();
    navigate('host-navigation');
    await expect(navigationAnswer).resolves.toBe(false);

    expect(() => pluginOverlay.confirm({title: 'Disposed?'})).toThrow(/is disposed/);
    await unmount(host);
    root.remove();
  });
});

describe('confirmHost initial focus', () => {
  it('starts focus on Cancel for danger confirmations and on Confirm otherwise', async () => {
    const root = document.createElement('div');

    document.body.appendChild(root);

    const host = mount(OverlayHost, {target: root, props: {runtime}});
    const {service: pluginOverlay} = createPluginOverlayService('demo', 'demo:1', runtime);

    const dangerAnswer = pluginOverlay.confirm({title: 'Remove?', danger: true});

    flushSync();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
    root.querySelectorAll<HTMLElement>('mndw-button')[1]?.click();
    await dangerAnswer;

    const normalAnswer = pluginOverlay.confirm({title: 'Save?'});

    flushSync();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement?.textContent?.trim()).toBe('Confirm');
    root.querySelectorAll<HTMLElement>('mndw-button')[1]?.click();
    await normalAnswer;

    await unmount(host);
    root.remove();
  });
});
