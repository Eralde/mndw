// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {defineMndwUi} from '@mndw/ui';
import {flushSync, mount, unmount} from 'svelte';

vi.mock('../runtime/plugin-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/plugin-registry.js')>(),
}));

import {type LoadedWidget, PluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {appState} from '../state/app.svelte.js';
import {createHostServices} from '../host-services.js';
import {createHostServicesContext} from '../host-services-context.js';
import FloatingAddPanel from './FloatingAddPanel.svelte';

const pluginRegistry = {getWidgets: vi.fn()} as unknown as PluginRegistry;

const emptyBackend = {routes: {}};

function widget(name: string, label: string, description = 'A short widget description.'): LoadedWidget {
  const entry: WidgetListEntry = {
    name,
    version: '1.0.0',
    label,
    description,
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

function widgetLabels(target: HTMLElement): string[] {
  return widgetButtons(target).map((button) =>
    button.querySelector('.mndw-floating-panel__label')?.textContent?.trim() ?? ''
  );
}

beforeAll(() => {
  defineMndwUi();
});

beforeEach(() => {
  appState.locale = 'en';
  vi.mocked(pluginRegistry).getWidgets.mockReturnValue([
    widget('traffic', 'Traffic'),
    widget('alpha-status', 'Status'),
    widget('beta-status', 'Status'),
  ]);
});

afterEach(() => {
  document.body.innerHTML = '';
  replaceDepsStatuses([]);
  appState.locale = 'en';
  vi.clearAllMocks();
});

describe('FloatingAddPanel rendering', () => {
  it('lists widgets sorted by label then name', () => {
    const {component, target} = mountPanel();
    const labels = widgetLabels(target);

    // Status/Status tie broken by name (alpha-status before beta-status), then Traffic.
    expect(labels).toEqual(['Status', 'Status', 'Traffic']);

    void unmount(component);
    target.remove();
  });

  it('shows each manifest description without widget size', () => {
    const {component, target} = mountPanel();
    const [firstButton] = widgetButtons(target);

    expect(target.textContent).toContain('A short widget description.');
    expect(firstButton?.querySelector('.mndw-floating-panel__description')?.textContent?.trim())
      .toBe('A short widget description.');
    expect(firstButton?.querySelector('.mndw-floating-panel__size')).toBeNull();

    void unmount(component);
    target.remove();
  });

  it('nests dependency status under label while preserving the accessible name order', () => {
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'installing'}]);

    const {component, target} = mountPanel();
    const trafficButton = widgetButtons(target).find((button) =>
      button.querySelector('.mndw-floating-panel__label')?.textContent?.includes('Traffic')
    );

    expect(trafficButton?.querySelector('.mndw-floating-panel__label .mndw-floating-panel__deps')?.textContent?.trim())
      .toBe('preparing…');
    expect(trafficButton?.getAttribute('aria-label'))
      .toBe('Traffic A short widget description. preparing…');

    void unmount(component);
    target.remove();
  });

  it('leaves the description column empty when description is empty', () => {
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([widget('plain', 'Plain', '')]);

    const {component, target} = mountPanel();
    const [plainButton] = widgetButtons(target);

    expect(plainButton?.querySelector('.mndw-floating-panel__description')).toBeNull();
    expect(plainButton?.querySelector('.mndw-floating-panel__details')).toBeNull();
    expect(plainButton?.querySelector('.mndw-floating-panel__size')).toBeNull();
    expect(plainButton?.children.length).toBe(1);
    expect(plainButton?.getAttribute('aria-label')).toBe('Plain');

    void unmount(component);
    target.remove();
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

describe('FloatingAddPanel localization', () => {
  it('omits widget size from Russian visible content and accessible name', () => {
    appState.locale = 'ru';
    vi.mocked(pluginRegistry).getWidgets.mockReturnValue([widget('plain', 'Обычный', 'Краткое описание')]);

    const {component, target} = mountPanel();
    const [plainButton] = widgetButtons(target);

    expect(plainButton?.querySelector('.mndw-floating-panel__description')?.textContent?.trim())
      .toBe('Краткое описание');
    expect(plainButton?.querySelector('.mndw-floating-panel__size')).toBeNull();
    expect(plainButton?.getAttribute('aria-label')).toBe('Обычный Краткое описание');

    void unmount(component);
    target.remove();
  });
});

describe('FloatingAddPanel actions', () => {
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
    const failedTrafficButton = widgetButtons(second.target).find((button) => button.textContent?.includes('Traffic'));

    expect(failedTrafficButton?.textContent).toContain('unavailable');
    expect(failedTrafficButton?.getAttribute('aria-label'))
      .toBe('Traffic A short widget description. unavailable');

    void unmount(second.component);
  });
});
