// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('../runtime/plugin-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/plugin-registry.js')>(),
  pluginRegistry: {getWidgets: vi.fn()},
}));

import {type LoadedWidget, pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import FloatingAddPanel from './FloatingAddPanel.svelte';

const emptyBackend = {routes: {}};

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
  close: ReturnType<typeof vi.fn>;
}

type MndwButtonHost = HTMLElement & {disabled: boolean};

function mountPanel(): PanelHandles {
  const target = document.createElement('div');

  document.body.appendChild(target);

  const onAddWidget = vi.fn();
  const close = vi.fn();
  const component = mount(FloatingAddPanel, {
    target,
    props: {onAddWidget, close},
    context: createHostServicesContext({...createHostServices(), registry: pluginRegistry}),
  });

  flushSync();

  return {component, target, onAddWidget, close};
}

function widgetButtons(target: HTMLElement): MndwButtonHost[] {
  return [...target.querySelectorAll<MndwButtonHost>('.mndw-floating-panel mndw-button')].filter(
    (btn) => btn.getAttribute('aria-label') !== 'Close',
  );
}

describe('FloatingAddPanel', () => {
  beforeAll(() => {
    defineMndwUi();
  });

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

  it('lists widgets sorted by label then name', () => {
    const {component, target} = mountPanel();
    const labels = widgetButtons(target).map((btn) => btn.textContent?.trim());

    // Status/Status tie broken by name (alpha-status before beta-status), then Traffic.
    expect(labels).toEqual(['Status', 'Status', 'Traffic']);

    void unmount(component);
    target.remove();
  });

  it('passes the canonical plugin name to onAddWidget and closes after adding', () => {
    const {component, target, onAddWidget, close} = mountPanel();
    const [firstStatus] = widgetButtons(target);

    firstStatus.click();

    expect(onAddWidget).toHaveBeenCalledWith('alpha-status');
    expect(close).toHaveBeenCalledWith(undefined);

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

  it('shows the shared compact empty state when no widgets are available', () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([]);

    const {component, target} = mountPanel();

    expect(target.querySelector('.mndw-empty-state--compact')?.textContent).toContain(
      'No widgets available',
    );

    void unmount(component);
    target.remove();
  });
});
