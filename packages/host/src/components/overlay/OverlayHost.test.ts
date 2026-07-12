import {describe, expect, it} from 'vitest';
import {mount, unmount} from 'svelte';
import OverlayHost from './OverlayHost.svelte';
import {createPluginOverlayService, resetOverlayStateForTests} from '../../services/overlay/overlay-manager.svelte.js';

describe('OverlayHost', () => {
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
});
