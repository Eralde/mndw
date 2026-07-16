import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {getWidgets: vi.fn()},
}));

import {type LoadedWidget, pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import FloatingAddPanel from './FloatingAddPanel.svelte';

const emptyBackend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function widget(name: string, label: string): LoadedWidget {
  const entry: WidgetListEntry = {
    name,
    version: '1.0.0',
    label,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3},
  };

  return {entry, module: {createInstance: vi.fn()}};
}

interface PanelHandles {
  component: ReturnType<typeof mount>;
  target: HTMLElement;
  onAddWidget: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

function mountPanel(open = true): PanelHandles {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const onAddWidget = vi.fn();
  const onClose = vi.fn();
  const component = mount(FloatingAddPanel, {target, props: {open, onAddWidget, onClose}});

  flushSync();

  return {component, target, onAddWidget, onClose};
}

function widgetButtons(target: HTMLElement): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>('.mndw-floating-panel button')].filter(
    (btn) => btn.getAttribute('aria-label') !== 'Close',
  );
}

describe('FloatingAddPanel', () => {
  beforeEach(() => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
      widget('traffic', 'Traffic'),
      widget('alpha-status', 'Status'),
      widget('beta-status', 'Status'),
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    replaceDepsStatuses([]);
    vi.clearAllMocks();
  });

  it('renders nothing while closed', () => {
    const {component, target} = mountPanel(false);

    expect(target.querySelector('.mndw-floating-panel')).toBeNull();

    void unmount(component);
    target.remove();
  });

  it('lists widgets sorted by label then name', () => {
    const {component, target} = mountPanel();
    const labels = widgetButtons(target).map((btn) => btn.textContent?.trim());

    // Status/Status tie broken by name (alpha-status before beta-status), then Traffic.
    expect(labels).toEqual(['Status', 'Status', 'Traffic']);

    void unmount(component);
    target.remove();
  });

  it('passes the canonical plugin name to onAddWidget and allows repeated adds', () => {
    const {component, target, onAddWidget} = mountPanel();
    const [firstStatus] = widgetButtons(target);

    firstStatus.click();
    firstStatus.click();

    expect(onAddWidget).toHaveBeenCalledTimes(2);
    expect(onAddWidget).toHaveBeenNthCalledWith(1, 'alpha-status');
    expect(onAddWidget).toHaveBeenNthCalledWith(2, 'alpha-status');

    void unmount(component);
    target.remove();
  });

  it('annotates installing and failed dependencies while keeping add enabled', () => {
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'installing'}]);

    const first = mountPanel();
    const trafficButton = widgetButtons(first.target).find((button) => button.textContent?.includes('Traffic'));

    expect(trafficButton?.textContent).toContain('preparing…');
    expect(trafficButton?.disabled).toBe(false);
    trafficButton?.click();
    expect(first.onAddWidget).toHaveBeenCalledWith('traffic');
    void unmount(first.component);

    replaceDepsStatuses([{name: 'traffic', depsStatus: 'failed'}]);

    const second = mountPanel();

    expect(widgetButtons(second.target).find((button) => button.textContent?.includes('Traffic'))?.textContent)
      .toContain('unavailable');

    void unmount(second.component);
  });

  it('focuses the first widget button when opened', async () => {
    const {component, target} = mountPanel();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(widgetButtons(target)[0]);

    void unmount(component);
    target.remove();
  });

  it('closes on backdrop click', () => {
    const {component, target, onClose} = mountPanel();

    target.querySelector<HTMLElement>('.mndw-floating-panel-backdrop')?.click();

    expect(onClose).toHaveBeenCalledTimes(1);

    void unmount(component);
    target.remove();
  });

  it('does not close when the dialog body is clicked', () => {
    const {component, target, onClose} = mountPanel();

    target.querySelector<HTMLElement>('.mndw-floating-panel')?.click();

    expect(onClose).not.toHaveBeenCalled();

    void unmount(component);
    target.remove();
  });

  it('closes on Escape', () => {
    const {component, target, onClose} = mountPanel();
    const panel = target.querySelector<HTMLElement>('.mndw-floating-panel');

    panel?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));

    expect(onClose).toHaveBeenCalledTimes(1);

    void unmount(component);
    target.remove();
  });

  it('shows an empty message when no widgets are available', () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([]);

    const {component, target} = mountPanel();

    expect(target.querySelector('.mndw-floating-panel__empty')?.textContent).toContain(
      'No widgets available',
    );

    void unmount(component);
    target.remove();
  });
});
