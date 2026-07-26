import {describe, expect, it} from 'vitest';
import {mount, unmount} from 'svelte';
import OverlayHost from './OverlayHost.svelte';
import {
  createPluginOverlayService,
  overlayStore,
  resetOverlayStateForTests,
} from '../../services/overlay/overlay-manager.svelte.js';

function mountHost() {
  resetOverlayStateForTests();

  const root = document.createElement('div');

  document.body.appendChild(root);

  const host = mount(OverlayHost, {target: root});

  return {
    root,
    dispose: () => {
      void unmount(host);
      root.remove();
      document.body.innerHTML = '';
    },
  };
}

async function anchoredPopover() {
  const harness = mountHost();
  const anchor = document.createElement('button');

  document.body.appendChild(anchor);

  const {service} = createPluginOverlayService('probe', 'probe:1');
  const layer = service.createLayer({kind: 'popover', anchor: {element: anchor}});

  layer.contentElement.textContent = 'Popover body';
  layer.setCleanup(() => {});
  layer.markReady();

  await Promise.resolve();
  await Promise.resolve();

  return {...harness, anchor, layer};
}

async function bottomDrawer() {
  const harness = mountHost();
  const {service} = createPluginOverlayService('probe', 'probe:1');
  const layer = service.open({
    kind: 'drawer',
    placement: 'bottom',
    title: 'Interface',
    showCloseButton: true,
    width: '100%',
    height: '100%',
    className: 'mndw-ui-select-sheet',
    mount(target) {
      target.textContent = 'Sheet body';
    },
  });

  await Promise.resolve();
  await Promise.resolve();

  return {...harness, layer};
}

describe('OverlayHost', () => {
  it('renders modal overlays as full-width content-sized sheets on mobile', async () => {
    const originalWidth = window.innerWidth;

    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 600});

    try {
      const harness = mountHost();
      const {service} = createPluginOverlayService('probe', 'probe:1');
      const layer = service.open({
        kind: 'modal',
        title: 'Settings',
        width: 240,
        height: 480,
        mount(target) {
          target.textContent = 'Modal body';
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      const positioner = harness.root.querySelector('.mndw-overlay-positioner');
      const dialog = harness.root.querySelector<HTMLElement>('[role="dialog"]');

      expect(positioner?.classList.contains('mndw-overlay-positioner--sheet')).toBe(true);
      expect(dialog?.classList.contains('mndw-overlay-dialog--sheet')).toBe(true);
      expect(dialog?.getAttribute('style')).toContain('width: 100%');
      expect(dialog?.getAttribute('style')).toContain('height: auto');
      expect(dialog?.getAttribute('style')).toContain('max-height: 100dvh');

      layer.close();
      await layer.closed;
      harness.dispose();
    } finally {
      Object.defineProperty(window, 'innerWidth', {configurable: true, value: originalWidth});
    }
  });

  it('keeps modal sizing and centered presentation above mobile breakpoint', async () => {
    const originalWidth = window.innerWidth;

    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 601});

    try {
      const harness = mountHost();
      const {service} = createPluginOverlayService('probe', 'probe:1');
      const layer = service.open({
        kind: 'modal',
        title: 'Settings',
        width: 240,
        height: 480,
        mount() {},
      });

      await Promise.resolve();
      await Promise.resolve();

      const positioner = harness.root.querySelector('.mndw-overlay-positioner');
      const dialog = harness.root.querySelector<HTMLElement>('[role="dialog"]');

      expect(positioner?.classList.contains('mndw-overlay-positioner--sheet')).toBe(false);
      expect(dialog?.classList.contains('mndw-overlay-dialog--sheet')).toBe(false);
      expect(dialog?.getAttribute('style')).toContain('width: 240px');
      expect(dialog?.getAttribute('style')).toContain('height: 480px');

      layer.close();
      await layer.closed;
      harness.dispose();
    } finally {
      Object.defineProperty(window, 'innerWidth', {configurable: true, value: originalWidth});
    }
  });

  it('renders right drawers as bottom sheets on mobile', async () => {
    const originalWidth = window.innerWidth;

    Object.defineProperty(window, 'innerWidth', {configurable: true, value: 600});

    try {
      const harness = mountHost();
      const {service} = createPluginOverlayService('probe', 'probe:1');
      const layer = service.open({
        kind: 'drawer',
        placement: 'right',
        title: 'Details',
        width: 320,
        height: '100%',
        mount(target) {
          target.textContent = 'Drawer body';
        },
      });

      await Promise.resolve();
      await Promise.resolve();

      const positioner = harness.root.querySelector('.mndw-overlay-positioner');
      const dialog = harness.root.querySelector<HTMLElement>('[role="dialog"]');

      expect(positioner?.classList.contains('mndw-overlay-positioner--sheet')).toBe(true);
      expect(dialog?.classList.contains('mndw-overlay-dialog--sheet')).toBe(true);
      expect(dialog?.getAttribute('style')).toContain('width: 100%');
      expect(dialog?.getAttribute('style')).toContain('height: auto');

      layer.close();
      await layer.closed;
      harness.dispose();
    } finally {
      Object.defineProperty(window, 'innerWidth', {configurable: true, value: originalWidth});
    }
  });

  it('renders host shell metadata for open() sessions', async () => {
    resetOverlayStateForTests();

    const root = document.createElement('div');

    document.body.appendChild(root);

    const host = mount(OverlayHost, {target: root});
    const {service} = createPluginOverlayService('demo', 'demo:1');

    service.open({
      kind: 'modal',
      title: 'Widget settings',
      mount(target, layer) {
        target.textContent = 'Dialog body';
        layer.setCleanup(() => {});
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(root.textContent).toContain('Widget settings');
    expect(root.textContent).toContain('Dialog body');

    void unmount(host);
    root.remove();
  });

  it('renders shellless createLayer() content directly', async () => {
    resetOverlayStateForTests();

    const root = document.createElement('div');

    document.body.appendChild(root);

    const host = mount(OverlayHost, {target: root});
    const {service} = createPluginOverlayService('demo', 'demo:1');
    const anchor = document.createElement('button');

    document.body.appendChild(anchor);

    const layer = service.createLayer({kind: 'popover', anchor: {element: anchor}});

    layer.contentElement.textContent = 'Popover body';
    layer.setCleanup(() => {});
    layer.markReady();

    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain('Popover body');

    void unmount(host);
    root.remove();
    anchor.remove();
  });

  it('does not dismiss an anchored popover when its own anchor is clicked', async () => {
    const {anchor, layer, dispose} = await anchoredPopover();

    anchor.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, composed: true}));
    await Promise.resolve();
    await Promise.resolve();

    expect(layer.isOpen).toBe(true);

    dispose();
  });

  it('dismisses an anchored popover when something else is clicked', async () => {
    const {layer, dispose} = await anchoredPopover();
    const elsewhere = document.createElement('div');

    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, composed: true}));

    await expect(layer.closed).resolves.toMatchObject({reason: 'outside-click'});
    expect(layer.isOpen).toBe(false);

    dispose();
  });

  it('renders a full-width bottom drawer with select sheet chrome', async () => {
    const {root, layer, dispose} = await bottomDrawer();
    const dialog = root.querySelector('[role="dialog"]');

    expect(dialog?.classList.contains('mndw-overlay-dialog--bottom')).toBe(true);
    expect(dialog?.classList.contains('mndw-ui-select-sheet')).toBe(true);
    expect(dialog?.getAttribute('style')).toContain('width: 100%');
    expect(dialog?.getAttribute('style')).toContain('height: 100%');
    expect(root.textContent).toContain('Interface');
    expect(root.textContent).toContain('Sheet body');
    expect(root.querySelector('[aria-label="Close"]')).not.toBeNull();

    layer.close();
    await layer.closed;
    dispose();
  });

  it('stretches the bottom drawer host wrapper to the viewport', async () => {
    const {root, layer, dispose} = await bottomDrawer();
    const wrapper = root.querySelector('.mndw-overlay-positioner--bottom > .mndw-overlay-layer');

    expect(wrapper).not.toBeNull();
    expect(wrapper && getComputedStyle(wrapper).height).toBe('100%');
    expect(wrapper && getComputedStyle(wrapper).display).toBe('flex');
    expect(wrapper && getComputedStyle(wrapper).justifyContent).toBe('flex-end');

    layer.close();
    await layer.closed;
    dispose();
  });

  it('closes a bottom drawer from its backdrop', async () => {
    const {root, layer, dispose} = await bottomDrawer();
    const backdrop = root.querySelector('.mndw-overlay-backdrop');

    if (!backdrop) {
      throw new Error('missing overlay backdrop');
    }

    backdrop.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, composed: true}));

    await expect(layer.closed).resolves.toMatchObject({reason: 'outside-click'});
    dispose();
  });

  it('keeps bottom drawer behavior flags enabled', async () => {
    const {layer, dispose} = await bottomDrawer();
    const [view] = overlayStore.layers;

    expect(view?.trapFocus).toBe(true);
    expect(view?.closeOnEscape).toBe(true);
    expect(view?.closeOnOutsideClick).toBe(true);
    expect(view?.lockScroll).toBe(true);

    layer.close();
    await layer.closed;
    dispose();
  });

  it('stacks a bottom drawer above a modal and restores nested scroll lock', async () => {
    const harness = mountHost();
    const {service} = createPluginOverlayService('probe', 'probe:1');
    const modal = service.open({
      kind: 'modal',
      title: 'Settings',
      mount(target) {
        target.textContent = 'Modal body';
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const drawer = service.open({
      kind: 'drawer',
      placement: 'bottom',
      title: 'Interface',
      width: '100%',
      height: '100%',
      mount() {},
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(overlayStore.layers).toHaveLength(2);
    expect(overlayStore.layers[1]?.kind).toBe('drawer');

    const overlayLayers = Array.from(harness.root.children).filter((element) =>
      element.classList.contains('mndw-overlay-layer')
    ) as HTMLElement[];

    expect(Number(overlayLayers[1].style.zIndex)).toBeGreaterThan(
      Number(overlayLayers[0].style.zIndex),
    );
    expect(document.body.style.overflow).toBe('hidden');

    const backdrops = harness.root.querySelectorAll('.mndw-overlay-backdrop');

    backdrops.item(1)?.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, composed: true}));
    await drawer.closed;
    expect(modal.isOpen).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    modal.close();
    await modal.closed;
    await Promise.resolve();
    await Promise.resolve();
    expect(document.body.style.overflow).toBe('');
    harness.dispose();
  });
});
