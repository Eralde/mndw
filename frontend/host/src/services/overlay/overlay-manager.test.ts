import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createPluginOverlayService, overlayStore, resetOverlayStateForTests} from './overlay-manager.svelte.js';

describe('overlay manager', () => {
  beforeEach(() => {
    resetOverlayStateForTests();
    document.body.innerHTML = '';
  });

  it('creates shell-backed sessions via open()', async () => {
    const {service} = createPluginOverlayService('demo', 'demo:1');

    const session = service.open({
      kind: 'modal',
      title: 'Settings',
      mount(target, layer) {
        target.textContent = 'body';
        layer.setCleanup(() => {});
      },
    });

    await Promise.resolve();

    expect(session.state).toBe('open');
    expect(overlayStore.layers).toHaveLength(1);
    expect(session.contentElement.textContent).toBe('body');
  });

  it('aborts opening layers when closeAll() runs', async () => {
    const {service} = createPluginOverlayService('demo', 'demo:1');

    const session = service.open({
      kind: 'drawer',
      async mount(_target, layer, signal) {
        layer.setCleanup(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(signal.aborted).toBe(true);
      },
    });

    service.closeAll();

    await expect(session.closed).resolves.toMatchObject({reason: 'api'});
  });

  it('restores focus to anchor when a closing popover owned focus', async () => {
    const {service} = createPluginOverlayService('demo', 'demo:1');
    const anchor = document.createElement('button');

    document.body.appendChild(anchor);

    const layer = service.createLayer({
      kind: 'popover',
      anchor: {element: anchor},
    });

    const button = document.createElement('button');

    layer.contentElement.appendChild(button);
    button.focus();
    layer.setCleanup(() => {});
    layer.markReady();

    layer.close(undefined, 'api');
    await layer.closed;

    expect(document.activeElement).toBe(anchor);
  });

  it('closes a same-plugin popover with reason replaced when a modal opens above it', async () => {
    const {service} = createPluginOverlayService('demo', 'demo:1');
    const anchor = document.createElement('button');

    document.body.appendChild(anchor);

    const popover = service.createLayer({
      kind: 'popover',
      anchor: {element: anchor},
      closeOnEscape: true,
    });

    popover.setCleanup(() => {});
    popover.markReady();

    service.open({
      kind: 'modal',
      title: 'Blocking',
      mount(_target, layer) {
        layer.setCleanup(() => {});
      },
    });

    await expect(popover.closed).resolves.toMatchObject({reason: 'replaced'});
  });

  it('resizes a createLayer() layer via update()', () => {
    const {service} = createPluginOverlayService('demo', 'demo:1');
    const anchor = document.createElement('button');

    document.body.appendChild(anchor);

    const layer = service.createLayer({
      kind: 'popover',
      anchor: {element: anchor},
      width: 240,
    });

    layer.setCleanup(() => {});
    layer.markReady();

    const [view] = overlayStore.layers;

    expect(view.sizing.width).toBe('240px');

    layer.update({width: 360, maxHeight: '50vh'});

    expect(view.sizing.width).toBe('360px');
    expect(view.sizing.maxHeight).toBe('50vh');
  });

  it('preserves bottom placement for drawer sessions', () => {
    const {service} = createPluginOverlayService('demo', 'demo:1');

    const layer = service.open({
      kind: 'drawer',
      placement: 'bottom',
      mount() {},
    });
    const view = overlayStore.layers[0];

    expect(layer.state).toBe('open');
    expect(view?.kind).toBe('drawer');
    expect(view?.placement).toBe('bottom');

    layer.close();
  });

  it('times out stuck opening layers with mount-failed', async () => {
    vi.useFakeTimers();

    const {service} = createPluginOverlayService('demo', 'demo:1');
    const layer = service.createLayer({kind: 'custom'});

    vi.advanceTimersByTime(10000);

    await expect(layer.closed).resolves.toMatchObject({reason: 'mount-failed'});
    vi.useRealTimers();
  });

  function anchoredPopover(pluginName = 'probe') {
    const anchor = document.createElement('button');

    document.body.appendChild(anchor);

    const {service, dispose} = createPluginOverlayService(pluginName, `${pluginName}:1`);
    const layer = service.createLayer({kind: 'popover', anchor: {element: anchor}});

    layer.setCleanup(() => {});
    layer.markReady();
    layer.contentElement.tabIndex = -1;
    layer.contentElement.focus();

    return {anchor, service, dispose, layer, focus: vi.spyOn(anchor, 'focus')};
  }

  function viewFor(layer: {contentElement: HTMLElement}) {
    const view = overlayStore.layers.find((candidate) => candidate.contentElement === layer.contentElement);

    if (!view) {
      throw new Error('layer view not found in overlayStore');
    }

    return view;
  }

  it('focuses a popover anchor when the plugin is unmounted', async () => {
    const {dispose, layer, focus} = anchoredPopover();

    dispose('plugin-unmount');
    await layer.closed;

    expect(focus).toHaveBeenCalled();
  });

  it('focuses a popover anchor on host navigation', async () => {
    const {dispose, layer, focus} = anchoredPopover();

    dispose('host-navigation');
    await layer.closed;

    expect(focus).toHaveBeenCalled();
  });

  it('focuses a popover anchor when a modal replaces it', async () => {
    const {service, layer, focus} = anchoredPopover();

    service.open({kind: 'modal', mount: () => undefined});

    await expect(layer.closed).resolves.toMatchObject({reason: 'replaced'});
    expect(focus).toHaveBeenCalled();
  });

  it('leaves focus alone when the popover is dismissed by an outside click', async () => {
    const {anchor, layer} = anchoredPopover();
    const elsewhere = document.createElement('button');

    document.body.appendChild(elsewhere);
    elsewhere.focus();

    const focus = vi.spyOn(anchor, 'focus');

    viewFor(layer).closeWithReason('outside-click');
    await layer.closed;

    expect(focus).not.toHaveBeenCalled();
  });
});
