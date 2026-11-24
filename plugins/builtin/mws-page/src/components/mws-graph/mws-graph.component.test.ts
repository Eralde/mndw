import '@angular/compiler';
import {readFileSync} from 'node:fs';
import {DestroyRef, inject, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {defineMndwUi} from '@mndw/ui';
import {createTranslatorSignals} from '@mndw/sdk/angular';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeMembers} from '../../api/normalize';
import {buildMap} from '../../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../../domain/mws/mws.types';
import {loadFixture} from '../../fixtures/load';
import {DEFAULT_LAYOUT_CONFIG} from './graph-layout';
import {EDGE_LABEL_GAP} from './graph-rendering';
import {MwsGraphComponent} from './mws-graph.component';
import {RSSI_THRESHOLDS_KEY, RssiThresholdsStore} from '../../services/rssi-thresholds.store';
import {SHARED_PLUGIN_STORAGE, TRANSLATOR} from '../../tokens';
import {FakePluginStorage} from '../../test-support/plugin-storage.fake';
import enCatalog from '../../../i18n/en.json';
import ruCatalog from '../../../i18n/ru.json';

const graphStyles = readFileSync('src/components/mws-graph/mws-graph.component.scss', 'utf8');

let testI18n = createTestI18n(enCatalog);

const ICON_SPRITE_URL = '/assets/test-icons.svg';

const CONTROLLER: ControllerInfo = {
  mac: '02:7d:4a:91:c3:10',
  ip: null,
  name: 'Router',
  model: 'Hopper (KN-3811)',
  firmware: '5.2 Alpha 1',
  interfaceUptime: null,
  isOnline: true,
};

function fixtureRoots(): MwsNode[] {
  return buildMap(normalizeMembers(loadFixture('show-mws-member.json')), [], CONTROLLER);
}

function mockComputedTextLength(measure: (value: string) => number): () => void {
  const original = Object.getOwnPropertyDescriptor(SVGTextElement.prototype, 'getComputedTextLength');

  Object.defineProperty(SVGTextElement.prototype, 'getComputedTextLength', {
    configurable: true,
    value(this: SVGTextElement): number {
      return measure(this.textContent ?? '');
    },
  });

  return () => {
    if (original === undefined) {
      delete (SVGTextElement.prototype as SVGTextElement & {getComputedTextLength?: () => number})
        .getComputedTextLength;
    } else {
      Object.defineProperty(SVGTextElement.prototype, 'getComputedTextLength', original);
    }
  };
}

describe('MwsGraphComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    testI18n = createTestI18n(enCatalog);
    defineMndwUi({iconSpriteUrl: ICON_SPRITE_URL});
    await resolveComponentResources((url: string) => {
      if (url.endsWith('mws-graph.component.scss')) {
        return Promise.resolve(graphStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [MwsGraphComponent],
      providers: [
        RssiThresholdsStore,
        {provide: SHARED_PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        {
          provide: TRANSLATOR,
          useFactory: () => createTranslatorSignals(testI18n, inject(DestroyRef)),
        },
      ],
    }).compileComponents();
  });

  it('renders a group per node and a path per edge without getBBox', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    expect(fixture.componentInstance.roots()).toHaveLength(1);

    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelectorAll('g.node')).toHaveLength(3);
    expect(element.querySelectorAll('path.edge')).toHaveLength(2);
    expect(element.querySelectorAll('path.edge.wireless')).toHaveLength(1);
    expect(element.querySelector('g.node.controller')).not.toBeNull();
  });

  it('renders separate body and selection-ring rectangles for every node', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelectorAll('rect.selection-ring')).toHaveLength(3);
    expect(element.querySelectorAll('rect.focus-ring')).toHaveLength(3);
    expect(element.querySelectorAll('rect.node-body')).toHaveLength(3);
    expect(element.querySelector('rect.node-body')?.getAttribute('width')).toBe(
      String(DEFAULT_LAYOUT_CONFIG.nodeWidth),
    );
    expect(element.querySelector('rect.node-body')?.getAttribute('height')).toBe(
      String(DEFAULT_LAYOUT_CONFIG.nodeHeight),
    );
    expect(DEFAULT_LAYOUT_CONFIG.nodeWidth).toBe(180);
    expect([...element.querySelectorAll<SVGRectElement>('rect.selection-ring')]
      .every((ring) => ring.style.display === 'none')).toBe(true);
    expect(graphStyles).not.toMatch(/:focus-visible\s+rect\s*\{/);
    expect(graphStyles).toContain('rect.focus-ring');
    expect(graphStyles).toContain('outline: none');
  });

  it('aligns node text to a padded left edge with balanced baselines and readable sizes', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const node = fixture.nativeElement.querySelector('g.node') as SVGGElement;
    const name = node.querySelector('text.name');
    const model = node.querySelector('text.model');
    const status = node.querySelector('text.status-line');

    expect([name, model, status].map((text) => text?.getAttribute('text-anchor'))).toEqual([
      'start',
      'start',
      'start',
    ]);
    expect([name, model, status].map((text) => text?.getAttribute('x'))).toEqual(['-78', '-78', '-78']);
    expect([name, model, status].map((text) => text?.getAttribute('y'))).toEqual(['-11', '5', '20']);

    const nameRule = graphStyles.match(/(?:&)?\.name\s*\{([^}]*)\}/s)?.[1] ?? '';
    const modelRule = graphStyles.match(/(?:&)?\.model\s*\{([^}]*)\}/s)?.[1] ?? '';
    const statusRule = graphStyles.match(/(?:&)?\.status-line\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(nameRule).toContain('font-size: 0.8125rem;');
    expect(nameRule).toContain('font-weight: 600;');
    expect(nameRule).toContain('fill: var(--mndw-text);');
    expect(modelRule).toContain('font-size: 0.6875rem;');
    expect(modelRule).toContain('fill: var(--mndw-text-subtle);');
    expect(statusRule).toContain('font-size: 0.6875rem;');
    expect(statusRule).toContain('fill: var(--mndw-text-subtle);');
  });

  it('refreshes imperative SVG translations after a locale switch', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const edgeTitle = fixture.nativeElement.querySelector<SVGTitleElement>('path.edge.wireless title');

    expect(edgeTitle?.textContent).toContain('Wireless');

    testI18n.setLocale('ru', ruCatalog);
    fixture.changeDetectorRef.detectChanges();

    expect(edgeTitle?.textContent).toContain('Беспроводное');
  });

  it('shows the selection ring only on the selected node and moves it when selection changes', () => {
    const roots = fixtureRoots();
    const firstNode = roots[0];
    const secondNode = firstNode?.children[0]?.node;
    const fixture = TestBed.createComponent(MwsGraphComponent);

    expect(firstNode).toBeDefined();
    expect(secondNode).toBeDefined();

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('selectedNodeId', null);
    fixture.detectChanges();

    fixture.componentRef.setInput('selectedNodeId', firstNode?.id ?? null);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const visibleRings = (): SVGRectElement[] =>
      [...element.querySelectorAll<SVGRectElement>('rect.selection-ring')]
        .filter((ring) => ring.style.display !== 'none');

    expect(visibleRings()).toHaveLength(1);
    expect(element.querySelector('g.node.selected rect.selection-ring')).not.toBeNull();

    fixture.componentRef.setInput('selectedNodeId', secondNode?.id ?? null);
    fixture.detectChanges();

    expect(visibleRings()).toHaveLength(1);
    expect(element.querySelector('g.node.selected rect.selection-ring')).not.toBeNull();
    expect(element.querySelector('g.node.selected')?.getAttribute('aria-label')).toContain(secondNode?.name ?? '');
  });

  it('marks nodes focusable with role=button and an aria-label', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const node = fixture.nativeElement.querySelector('g.node') as SVGGElement;

    expect(node.getAttribute('role')).toBe('button');
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(node.getAttribute('aria-label')).toBeTruthy();
  });

  it('hides telemetry and remote-control markers while extra features are inactive', () => {
    const roots = fixtureRoots();
    const extender = roots.flatMap((root) => collectNodes(root)).find((node) => !node.isController);

    if (extender === undefined) {
      throw new Error('fixture roots missing an extender');
    }

    extender.mwsdStatus = {state: 'stale', lastTelemetryAt: Date.now() - 100_000};
    extender.persistentSession = false;

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('extraFeaturesAvailability', 'limited');
    fixture.detectChanges();

    const node = fixture.nativeElement.querySelector(`g.node[data-node-id="${extender.id}"]`) as SVGGElement;

    expect(node.querySelectorAll('svg.node-icon')).toHaveLength(0);
    expect(
      fixture.nativeElement.querySelectorAll(
        'circle.update-dot, circle.mwsd-status-dot, circle.persistent-session-dot',
      ),
    )
      .toHaveLength(0);
    expect(node.getAttribute('aria-label')).not.toContain('Telemetry: stale');
    expect(node.getAttribute('aria-label')).not.toContain('Remote control: disconnected');
  });

  it('shows only online problem markers when extra features are active and names visible markers', () => {
    const roots = fixtureRoots();
    const extenders = roots.flatMap((root) => collectNodes(root)).filter((node) => !node.isController);
    const first = extenders[0];
    const second = extenders[1];

    if (first === undefined || second === undefined) {
      throw new Error('fixture roots missing expected extenders');
    }

    const variants = ['live', 'starting', 'stale', 'offline', 'unavailable'].map((state) => ({
      ...first,
      id: `status-${state}`,
      name: `Status ${state}`,
      isOnline: true,
      parent: null,
      children: [],
      mwsdStatus: {state: state as 'live' | 'starting' | 'stale' | 'offline' | 'unavailable', lastTelemetryAt: null},
      persistentSession: state !== 'stale',
    }));
    const offlineNode = {
      ...second,
      id: 'offline-node',
      name: 'Offline node',
      isOnline: false,
      parent: null,
      children: [],
      mwsdStatus: {state: 'stale' as const, lastTelemetryAt: null},
      persistentSession: false,
      fw: '1.0',
      fwAvailable: '2.0',
      clients: [{
        mac: '02:00:00:00:00:01',
        name: 'Test client',
        ip: null,
        uptime: null,
        lastSeen: null,
        wired: false,
        active: true,
      }],
    };
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', [...roots, ...variants, offlineNode]);
    fixture.componentRef.setInput('extraFeaturesAvailability', 'active');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelectorAll('circle.update-dot, circle.mwsd-status-dot, circle.persistent-session-dot'))
      .toHaveLength(0);
    expect(element.querySelectorAll('g.node[data-node-id="status-live"] svg.node-icon')).toHaveLength(0);
    expect(element.querySelectorAll('g.node[data-node-id="status-starting"] svg.node-icon')).toHaveLength(0);
    expect(element.querySelectorAll('g.node[data-node-id="status-unavailable"] svg.node-icon')).toHaveLength(0);
    expect(element.querySelector('g.node[data-node-id="status-stale"] svg.node-icon[data-icon="activity"]'))
      .not.toBeNull();
    expect(element.querySelector('g.node[data-node-id="status-offline"] svg.node-icon[data-icon="activity"]'))
      .not.toBeNull();
    expect(element.querySelector('g.node[data-node-id="status-stale"] svg.node-icon[data-icon="unlink"]'))
      .not.toBeNull();
    expect(element.querySelectorAll('g.node[data-node-id="status-live"] svg.node-icon[data-icon="unlink"]'))
      .toHaveLength(0);
    expect(element.querySelector('g.node[data-node-id="offline-node"]')?.classList.contains('offline')).toBe(true);
    expect(element.querySelectorAll('g.node[data-node-id="offline-node"] svg.node-icon')).toHaveLength(0);
    expect(element.querySelector('g.node[data-node-id="status-stale"]')?.getAttribute('aria-label'))
      .toContain('Telemetry: stale');
    expect(element.querySelector('g.node[data-node-id="status-stale"]')?.getAttribute('aria-label'))
      .toContain('Remote control: disconnected');
    expect(element.querySelector('g.node[data-node-id="status-live"]')?.getAttribute('aria-label'))
      .not.toContain('Telemetry: live');
    expect(element.querySelector('g.node[data-node-id="offline-node"]')?.getAttribute('aria-label'))
      .not.toContain('Telemetry: stale');
    expect(element.querySelector('g.node[data-node-id="offline-node"]')?.getAttribute('aria-label'))
      .toContain('Offline');
    expect(element.querySelector('g.node[data-node-id="offline-node"] text.status-line')?.textContent)
      .toBe('Offline');
    expect(element.querySelector('g.node[data-node-id="offline-node"] text.status-line')?.textContent)
      .not.toContain('client');
    expect(element.querySelector('g.node[data-node-id="offline-node"] text.status-line')?.getAttribute('fill'))
      .toBeNull();

    const offlineStart = graphStyles.indexOf('&.offline {');
    const offlineEnd = graphStyles.indexOf('&.on-path', offlineStart);
    const offlineStyles = graphStyles.slice(offlineStart, offlineEnd);

    expect(offlineStyles).toContain(
      '--mws-offline-color: color-mix(in srgb, var(--mndw-danger) 55%, var(--mndw-border));',
    );
    expect(offlineStyles).toMatch(/rect\.node-body\s*\{[^}]*stroke:\s*var\(--mws-offline-color\);/s);
    expect(offlineStyles).toMatch(/text\.status-line\s*\{[^}]*fill:\s*var\(--mws-offline-color\);/s);
    expect(graphStyles).toMatch(
      /&\.controller rect\.node-body\s*\{[^}]*stroke-width:\s*3;/s,
    );
    expect(graphStyles).toMatch(
      /&\.offline\.on-path rect\.node-body\s*\{[^}]*filter:\s*drop-shadow\(0 0 4px var\(--mws-offline-color\)\);[^}]*stroke:\s*var\(--mws-offline-color\);/s,
    );
    expect(graphStyles).toMatch(
      /&\.offline\.selected rect\.selection-ring\s*\{[^}]*stroke:\s*var\(--mws-offline-color\);/s,
    );
    expect(graphStyles).toMatch(
      /&\.offline\.selected rect\.node-body\s*\{[^}]*filter:\s*drop-shadow\(0 0 6px var\(--mws-offline-color\)\);/s,
    );
    expect(graphStyles).toMatch(
      /&?\.offline\s+text\.name,\s*&?\.offline\s+text\.model\s*\{[^}]*fill:\s*var\(--mndw-text-subtle\);/s,
    );
  });

  it('renders only failing remote-control state for configured extenders when active', () => {
    const roots = fixtureRoots();
    const nodes = roots.flatMap((root) => collectNodes(root));
    const extenders = nodes.filter((node) => !node.isController);

    extenders[0].persistentSession = true;
    extenders[1].persistentSession = false;

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('extraFeaturesAvailability', 'active');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelectorAll('circle.persistent-session-dot')).toHaveLength(0);
    expect(element.querySelectorAll('g.node svg.node-icon[data-icon="unlink"]')).toHaveLength(1);
    expect(element.querySelector('g.node.persistent-failing svg.node-icon[data-icon="unlink"]')).not.toBeNull();
    expect(element.querySelector('g.node.controller svg.node-icon[data-icon="unlink"]')).toBeNull();
    expect(element.querySelector('g.node.persistent-live')?.getAttribute('aria-label')).not.toContain(
      'Remote control: connected',
    );
    expect(element.querySelector('g.node.persistent-failing')?.getAttribute('aria-label')).toContain(
      'Remote control: disconnected',
    );
    expect(element.querySelector('svg.node-icon[data-icon="unlink"] title')?.textContent)
      .toBe('Remote control: disconnected');
  });

  it('stacks update, telemetry, and remote-control icons in order with sprite hrefs', () => {
    const roots = fixtureRoots();
    const extender = roots[0]?.children[0]?.node;

    if (extender === undefined) {
      throw new Error('fixture roots missing an extender');
    }

    extender.fw = '1.0';
    extender.fwAvailable = '2.0';
    extender.mwsdStatus = {state: 'stale', lastTelemetryAt: null};
    extender.persistentSession = false;

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('extraFeaturesAvailability', 'active');
    fixture.detectChanges();

    const node = fixture.nativeElement.querySelector(`g.node[data-node-id="${extender.id}"]`) as SVGGElement;
    const icons = [...node.querySelectorAll<SVGSVGElement>('svg.node-icon')];

    expect(icons.map((icon) => icon.getAttribute('data-icon'))).toEqual([
      'circle-arrow-up',
      'activity',
      'unlink',
    ]);
    expect(icons.map((icon) => icon.getAttribute('x'))).toEqual(['64', '64', '64']);
    expect(icons.map((icon) => icon.getAttribute('y'))).toEqual(['-22', '-6', '10']);
    expect(icons.map((icon) => [icon.getAttribute('width'), icon.getAttribute('height')])).toEqual([
      ['14', '14'],
      ['14', '14'],
      ['14', '14'],
    ]);
    expect(icons.map((icon) => icon.querySelector('use')?.getAttribute('href'))).toEqual([
      `${ICON_SPRITE_URL}#mndw-icon-circle-arrow-up`,
      `${ICON_SPRITE_URL}#mndw-icon-activity`,
      `${ICON_SPRITE_URL}#mndw-icon-unlink`,
    ]);
    expect(icons.map((icon) => icon.querySelector('title')?.textContent)).toEqual([
      'Update available',
      'Telemetry: stale',
      'Remote control: disconnected',
    ]);
    expect(icons.map((icon) => icon.style.color)).toEqual([
      'var(--mndw-info)',
      'var(--mndw-warning)',
      'var(--mndw-warning)',
    ]);
    expect(icons.every((icon) => icon.style.stroke === 'currentColor')).toBe(true);
    expect(node.querySelector('text.name')?.textContent?.length).toBeLessThanOrEqual(16);
    expect(node.getAttribute('aria-label')).toContain('Update available');
    expect(node.getAttribute('aria-label')).toContain('Telemetry: stale');
    expect(node.getAttribute('aria-label')).toContain('Remote control: disconnected');
  });

  it('uses computed SVG text width to truncate when the browser exposes it', () => {
    const original = Object.getOwnPropertyDescriptor(SVGTextElement.prototype, 'getComputedTextLength');

    Object.defineProperty(SVGTextElement.prototype, 'getComputedTextLength', {
      configurable: true,
      value(this: SVGElement): number {
        return (this.textContent?.length ?? 0) * 20;
      },
    });

    try {
      const roots = fixtureRoots();
      const controller = roots[0];

      if (controller === undefined) {
        throw new Error('fixture roots missing controller');
      }

      controller.name = 'A very long controller name';

      const fixture = TestBed.createComponent(MwsGraphComponent);

      fixture.componentRef.setInput('roots', roots);
      fixture.detectChanges();

      const name = fixture.nativeElement.querySelector('g.node.controller text.name')?.textContent ?? '';

      expect(name.endsWith('…')).toBe(true);
      expect(name.length).toBeLessThan('A very long controller name'.length);
      fixture.destroy();
    } finally {
      if (original === undefined) {
        delete (SVGTextElement.prototype as SVGTextElement & {getComputedTextLength?: () => number})
          .getComputedTextLength;
      } else {
        Object.defineProperty(SVGTextElement.prototype, 'getComputedTextLength', original);
      }
    }
  });

  it('re-fits pending node text after resize without a data change and stops retrying after success', () => {
    let measurable = false;
    let resizeCallback: ResizeObserverCallback | null = null;
    const restoreTextMeasurement = mockComputedTextLength((value) => measurable ? value.length * 20 : 0);
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
      frames.push(callback);

      return frames.length;
    });
    const cancelFrame = vi.fn();

    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        public constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        public observe(): void {}
        public disconnect(): void {}
      },
    );

    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    const originalName = 'A deliberately long controller name that must be refitted';

    controller.name = originalName;

    const fixture = TestBed.createComponent(MwsGraphComponent);

    try {
      fixture.componentRef.setInput('roots', roots);
      fixture.detectChanges();

      const name = fixture.nativeElement.querySelector('g.node.controller text.name') as SVGTextElement;
      const fallbackName = name.textContent ?? '';
      const scheduledFrame = (fixture.componentInstance as unknown as {textFitFrame: number | null}).textFitFrame;
      const requestCount = requestFrame.mock.calls.length;

      expect(fallbackName.endsWith('…')).toBe(true);
      expect(scheduledFrame).not.toBeNull();
      expect(requestCount).toBeGreaterThan(0);

      measurable = true;
      Object.defineProperties(name.ownerSVGElement?.parentElement, {
        clientWidth: {configurable: true, value: 400},
        clientHeight: {configurable: true, value: 300},
      });
      resizeCallback?.([], {} as ResizeObserver);

      expect(name.textContent?.endsWith('…')).toBe(true);
      expect(name.textContent?.length).toBeLessThan(fallbackName.length);
      expect(controller.name).toBe(originalName);
      expect(cancelFrame).toHaveBeenCalledWith(scheduledFrame);

      if (scheduledFrame !== null) {
        frames[scheduledFrame - 1]?.(0);
      }

      expect(requestFrame).toHaveBeenCalledTimes(requestCount);
    } finally {
      fixture.destroy();
      vi.unstubAllGlobals();
      restoreTextMeasurement();
    }
  });

  it('keeps the zero-measurement fallback within the estimated text width', () => {
    const restoreTextMeasurement = mockComputedTextLength(() => 0);
    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    controller.name = 'An exceptionally long node name that exceeds its card width';
    controller.model = 'An exceptionally long model name that exceeds its card width';

    const fixture = TestBed.createComponent(MwsGraphComponent);

    try {
      fixture.componentRef.setInput('roots', roots);
      fixture.detectChanges();

      const node = fixture.nativeElement.querySelector('g.node.controller') as SVGGElement;
      const iconWidth = node.querySelectorAll('svg.node-icon').length > 0 ? 22 : 0;
      const maxWidth = DEFAULT_LAYOUT_CONFIG.nodeWidth - 24 - iconWidth;
      const name = node.querySelector('text.name')?.textContent ?? '';
      const model = node.querySelector('text.model')?.textContent ?? '';

      expect(name.length * 8.5).toBeLessThanOrEqual(maxWidth);
      expect(model.length * 7.5).toBeLessThanOrEqual(maxWidth);
      expect(name.endsWith('…')).toBe(true);
      expect(model.endsWith('…')).toBe(true);
    } finally {
      fixture.destroy();
      restoreTextMeasurement();
    }
  });

  it('refreshes icon hrefs when the sprite changes and unsubscribes on destroy', () => {
    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    controller.fw = '1.0';
    controller.fwAvailable = '2.0';

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const use = fixture.nativeElement.querySelector<SVGUseElement>('svg.node-icon use');

    expect(use?.getAttribute('href')).toBe(`${ICON_SPRITE_URL}#mndw-icon-circle-arrow-up`);

    defineMndwUi({iconSpriteUrl: '/assets/second-icons.svg'});

    expect(use?.getAttribute('href')).toBe('/assets/second-icons.svg#mndw-icon-circle-arrow-up');

    fixture.destroy();
    defineMndwUi({iconSpriteUrl: '/assets/third-icons.svg'});

    expect(use?.getAttribute('href')).toBe('/assets/second-icons.svg#mndw-icon-circle-arrow-up');
  });

  it('removes the client badge, pluralizes counts, and names the update marker', () => {
    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);
    const element = fixture.nativeElement as HTMLElement;

    for (
      const [locale, catalog, count, expected, updateLabel] of [
        ['en', enCatalog, 1, '1 client', 'Update available'],
        ['en', enCatalog, 2, '2 clients', 'Update available'],
        ['en', enCatalog, 5, '5 clients', 'Update available'],
        ['ru', ruCatalog, 1, '1 клиент', 'Доступно обновление'],
        ['ru', ruCatalog, 2, '2 клиента', 'Доступно обновление'],
        ['ru', ruCatalog, 5, '5 клиентов', 'Доступно обновление'],
      ] as const
    ) {
      testI18n.setLocale(locale, catalog);
      controller.clients = Array.from({length: count}, (_, index) => ({
        mac: `02:00:00:00:00:${String(index).padStart(2, '0')}`,
        name: `Client ${index + 1}`,
        ip: null,
        uptime: null,
        lastSeen: null,
        wired: false,
        active: true,
      }));
      controller.fw = '1.0';
      controller.fwAvailable = '2.0';
      fixture.componentRef.setInput('roots', [...roots]);
      fixture.detectChanges();

      const node = element.querySelector<SVGGElement>('g.node.controller');

      if (node === null) {
        throw new Error('controller node missing');
      }

      expect(node.querySelector('text.client-count')?.textContent).toBe(expected);
      expect(node.querySelector('g.client-badge')).toBeNull();
      expect(node.getAttribute('aria-label')).toContain(updateLabel);
    }

    const updateIcon = element.querySelector<SVGSVGElement>(
      'g.node.controller svg.node-icon[data-icon="circle-arrow-up"]',
    );

    expect(updateIcon?.style.color).toBe('var(--mndw-info)');
    expect(updateIcon?.querySelector('title')?.textContent).toBe('Доступно обновление');
    expect(updateIcon?.querySelector('use')?.getAttribute('href'))
      .toBe(`${ICON_SPRITE_URL}#mndw-icon-circle-arrow-up`);
  });

  it('emits nodeSelected on click and on Enter', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const selected: string[] = [];

    fixture.componentInstance.nodeSelected.subscribe((id: string) => selected.push(id));

    const root = fixture.nativeElement as HTMLElement;
    const nodes = Array.from(root.querySelectorAll<SVGGElement>('g.node'));

    nodes[0].dispatchEvent(new MouseEvent('click', {bubbles: true}));
    nodes[1].dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));

    expect(selected).toHaveLength(2);
    expect(new Set(selected).size).toBe(2);
  });

  it('renders edit actions beside view controls and emits their requests', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);
    const component = fixture.componentInstance;
    const toggled = vi.fn();
    const autoLayout = vi.fn();
    const done = vi.fn();

    component.editModeToggled.subscribe(toggled);
    component.autoLayoutRequested.subscribe(autoLayout);
    component.doneEditingRequested.subscribe(done);
    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.graph-edit-controls')).not.toBeNull();

    element.querySelector<HTMLElement>('[aria-label="Rearrange"]')?.click();
    expect(toggled).toHaveBeenCalledOnce();
    expect(element.querySelector('[aria-label="Auto layout"]')).toBeNull();

    fixture.componentRef.setInput('editMode', true);
    fixture.detectChanges();
    element.querySelector<HTMLElement>('[aria-label="Auto layout"]')?.click();
    element.querySelector<HTMLElement>('[aria-label="Done"]')?.click();

    expect(autoLayout).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  it('keeps the rearrange control stable while editing', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.componentRef.setInput('editMode', true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const rearrange = element.querySelector<HTMLElement>('[aria-label="Rearrange"]') as
      | (HTMLElement & {disabled?: boolean})
      | null;
    const editButtons = Array.from(element.querySelectorAll<HTMLElement>('.graph-edit-controls mndw-button'));

    expect(rearrange?.textContent?.trim()).toBe('Rearrange');
    expect(rearrange?.disabled).toBe(true);
    expect(editButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Auto layout',
      'Done',
      'Rearrange',
    ]);
  });

  it('labels each link with the target rate above the top-left card corner', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const labels = [...element.querySelectorAll<SVGTextElement>('text.edge-label')];

    expect(labels.map((label) => label.textContent).sort()).toEqual(['1 Gbit/s', '1.2 Gbit/s']);

    for (const label of labels) {
      const id = label.getAttribute('data-target-id') ?? '';
      const node = element.querySelector<SVGGElement>(`g.node[data-node-id="${id}"]`);
      const transform = node?.getAttribute('transform') ?? '';
      const [, nodeX = '0', nodeY = '0'] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(transform) ?? [];

      expect(Number(label.getAttribute('x'))).toBeCloseTo(Number(nodeX) - DEFAULT_LAYOUT_CONFIG.nodeWidth / 2);
      expect(Number(label.getAttribute('y'))).toBeCloseTo(
        Number(nodeY) - DEFAULT_LAYOUT_CONFIG.nodeHeight / 2 - EDGE_LABEL_GAP,
      );
      expect(label.getAttribute('aria-hidden')).toBe('true');
    }

    expect(graphStyles).toMatch(/\.zoom-hide-indicators \.edge-label\s*\{[^}]*display:\s*none;/s);
  });

  it('draws no label when the target has no link value', () => {
    const roots = fixtureRoots();

    for (const node of roots.flatMap((root) => collectNodes(root))) {
      if (node.backhaul !== null) {
        node.backhaul.txrate = null;
        node.backhaul.speed = null;
      }
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('text.edge-label')).toHaveLength(0);
  });

  it('keeps the label layer above node cards added after the first render', () => {
    const roots = fixtureRoots();
    const controller = roots[0];
    const firstChild = controller?.children[0]?.node;

    if (controller === undefined || firstChild === undefined) {
      throw new Error('fixture roots missing controller child');
    }

    const extra: MwsNode = {
      ...firstChild,
      id: 'extra-node',
      mac: 'extra-node',
      name: 'Extra node',
      children: [],
      parent: {type: 'wired', node: controller},
    };
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    controller.children = [...controller.children, {type: 'wired', node: extra}];
    fixture.componentRef.setInput('roots', [...roots]);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const group = element.querySelector('svg > g');
    const children = [...(group?.children ?? [])];
    const layerIndex = children.findIndex((child) => child.classList.contains('edge-labels'));
    const nodeIndexes = children.flatMap((child, index) => child.classList.contains('node') ? [index] : []);
    const lastNodeIndex = Math.max(...nodeIndexes);

    expect(element.querySelector('g.node[data-node-id="extra-node"]')).not.toBeNull();
    expect(children[layerIndex]?.classList.contains('edge-labels')).toBe(true);
    expect(layerIndex).toBeGreaterThan(lastNodeIndex);
    expect(element.querySelectorAll('text.edge-label')).toHaveLength(3);
  });

  it('moves the label with the node position', () => {
    const roots = fixtureRoots();
    const target = roots.flatMap((root) => collectNodes(root))
      .find((node) => !node.isController && node.backhaul?.txrate !== null && node.backhaul?.txrate !== undefined);

    if (target === undefined) {
      throw new Error('fixture roots missing a wireless extender');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    fixture.componentRef.setInput('nodePositions', new Map([[target.id, {x: 360, y: 240}]]));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const label = element.querySelector<SVGTextElement>(`text.edge-label[data-target-id="${target.id}"]`);
    const node = element.querySelector<SVGGElement>(`g.node[data-node-id="${target.id}"]`);

    expect(label).not.toBeNull();
    expect(node?.getAttribute('transform')).toBe('translate(360,240)');
    expect(Number(label?.getAttribute('x'))).toBeCloseTo(360 - DEFAULT_LAYOUT_CONFIG.nodeWidth / 2);
    expect(Number(label?.getAttribute('y'))).toBeCloseTo(
      240 - DEFAULT_LAYOUT_CONFIG.nodeHeight / 2 - EDGE_LABEL_GAP,
    );
  });

  it('updates the label through the drag update path', () => {
    const roots = fixtureRoots();
    const target = roots.flatMap((root) => collectNodes(root))
      .find((node) => !node.isController && node.backhaul?.txrate !== null && node.backhaul?.txrate !== undefined);

    if (target === undefined) {
      throw new Error('fixture roots missing a wireless extender');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const component = fixture.componentInstance as unknown as {
      dragPositions: Map<string, {x: number; y: number}>;
      updateIncidentEdges: (id: string) => void;
    };

    component.dragPositions.set(target.id, {x: 360, y: 240});
    component.updateIncidentEdges(target.id);

    const label = (fixture.nativeElement as HTMLElement)
      .querySelector<SVGTextElement>(`text.edge-label[data-target-id="${target.id}"]`);

    expect(Number(label?.getAttribute('x'))).toBeCloseTo(360 - DEFAULT_LAYOUT_CONFIG.nodeWidth / 2);
    expect(Number(label?.getAttribute('y'))).toBeCloseTo(
      240 - DEFAULT_LAYOUT_CONFIG.nodeHeight / 2 - EDGE_LABEL_GAP,
    );
  });

  it('recolours edges when the RSSI thresholds change', () => {
    const store = TestBed.inject(RssiThresholdsStore);
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const edge = (): SVGPathElement | null => fixture.nativeElement.querySelector('path.edge.wireless');

    expect(edge()?.classList.contains('good')).toBe(true);

    store.setThresholds({good: -20, fair: -30});
    fixture.detectChanges();

    expect(edge()?.classList.contains('good')).toBe(false);
    expect(edge()?.classList.contains('weak')).toBe(true);
  });

  it('validates and saves RSSI thresholds from the map toolbar', async () => {
    const store = TestBed.inject(RssiThresholdsStore);
    const storage = TestBed.inject(SHARED_PLUGIN_STORAGE) as FakePluginStorage;
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const toggle = element.querySelector<HTMLElement>('[aria-label="Wireless signal thresholds"]');
    const panel = (): HTMLElement | null => element.querySelector('.rssi-thresholds-panel');

    expect(panel()).toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    toggle?.click();
    fixture.detectChanges();

    expect(panel()).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    const good = element.querySelector<HTMLElement & {value: string}>('[data-field="rssi-good"]');
    const fair = element.querySelector<HTMLElement & {value: string}>('[data-field="rssi-fair"]');
    const goodField = element.querySelector<HTMLElement & {error: string}>('.rssi-thresholds-panel mndw-field');

    expect(good?.value).toBe('-55');
    expect(fair?.value).toBe('-70');

    good?.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: '-10'}}));
    fixture.detectChanges();

    expect(goodField?.error).toBe('Enter a whole number from −100 to −20.');

    element.querySelector<HTMLElement>('[data-action="apply-rssi-thresholds"]')?.click();
    await store.flush();

    expect(store.thresholds()).toEqual({good: -55, fair: -70});
    expect(storage.read(RSSI_THRESHOLDS_KEY)).toBeNull();

    good?.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: '-50'}}));
    fair?.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: '-75'}}));
    fixture.detectChanges();

    element.querySelector<HTMLElement>('[data-action="apply-rssi-thresholds"]')?.click();
    await store.flush();
    fixture.detectChanges();

    expect(store.thresholds()).toEqual({good: -50, fair: -75});
    expect(JSON.parse(storage.read(RSSI_THRESHOLDS_KEY) ?? '{}')).toEqual({
      version: 1,
      thresholds: {good: -50, fair: -75},
    });
    expect(panel()).toBeNull();
  });

  it('closes the RSSI panel with Escape and the toolbar button', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const toggle = element.querySelector<HTMLElement>('[aria-label="Wireless signal thresholds"]');

    toggle?.click();
    fixture.detectChanges();
    expect(element.querySelector('.rssi-thresholds-panel')).not.toBeNull();

    element.querySelector('[data-field="rssi-good"]')?.dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}),
    );
    fixture.detectChanges();
    expect(element.querySelector('.rssi-thresholds-panel')).toBeNull();

    toggle?.click();
    fixture.detectChanges();
    expect(element.querySelector('.rssi-thresholds-panel')).not.toBeNull();

    toggle?.click();
    fixture.detectChanges();
    expect(element.querySelector('.rssi-thresholds-panel')).toBeNull();
  });

  it('lets threshold inputs type keys that are graph shortcuts', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const toggle = element.querySelector<HTMLElement>('[aria-label="Wireless signal thresholds"]');

    toggle?.click();
    fixture.detectChanges();

    const input = element.querySelector<HTMLElement>('[data-field="rssi-good"]');
    const svg = element.querySelector('svg');
    const zoomGroup = element.querySelector('svg > g');
    const beforeTransform = zoomGroup?.getAttribute('transform');
    const minus = new KeyboardEvent('keydown', {key: '-', bubbles: true, composed: true, cancelable: true});
    const zero = new KeyboardEvent('keydown', {key: '0', bubbles: true, composed: true, cancelable: true});

    input?.dispatchEvent(minus);
    input?.dispatchEvent(zero);
    fixture.detectChanges();

    expect(minus.defaultPrevented).toBe(false);
    expect(zero.defaultPrevented).toBe(false);
    expect(zoomGroup?.getAttribute('transform')).toBe(beforeTransform);

    const svgMinus = new KeyboardEvent('keydown', {key: '-', bubbles: true, composed: true, cancelable: true});

    svg?.dispatchEvent(svgMinus);
    fixture.detectChanges();

    expect(svgMinus.defaultPrevented).toBe(true);
    expect(zoomGroup?.getAttribute('transform')).not.toBe(beforeTransform);
  });

  it('truncates visible names while retaining one top-level full-name title across rerenders', () => {
    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    const fullName = 'A node name that is deliberately much longer than the visible label';

    controller.name = fullName;

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const node = element.querySelector<SVGGElement>('g.node[data-node-id="02:7d:4a:91:c3:10"]');
    const title = node?.firstElementChild;
    const name = node?.querySelector('text.name');

    expect(title?.matches('title.node-name-title')).toBe(true);
    expect(title?.textContent).toBe(fullName);
    expect(name?.textContent).not.toBe(fullName);
    expect(name?.textContent?.endsWith('…')).toBe(true);
    expect(node?.querySelectorAll('title.node-name-title')).toHaveLength(1);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

    const rerenderedNode = element.querySelector<SVGGElement>('g.node[data-node-id="02:7d:4a:91:c3:10"]');

    expect(rerenderedNode?.querySelectorAll('title.node-name-title')).toHaveLength(1);
  });

  it('highlights pointer paths and restores selected paths after pointerleave', () => {
    const roots = fixtureRoots();
    const controller = roots.find((node) => node.isController);
    const extenders = roots.flatMap((root) => collectNodes(root)).filter((node) => !node.isController);
    const firstChild = extenders[0];
    const secondChild = extenders[1];

    if (controller === undefined || firstChild === undefined || secondChild === undefined) {
      throw new Error('fixture roots missing expected topology');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('selectedNodeId', secondChild.id);
    fixture.detectChanges();

    dispatchNodeEvent(fixture, firstChild.id, 'pointerenter');
    expect(fixture.nativeElement.querySelectorAll('path.edge.on-path')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('path.edge:not(.on-path)')).toHaveLength(1);
    expect(visibleRing(fixture, firstChild.id)).toBe(true);

    dispatchNodeEvent(fixture, firstChild.id, 'pointerleave');
    expect(fixture.nativeElement.querySelectorAll('path.edge.on-path').length).toBeGreaterThan(0);
    expect(visibleRing(fixture, secondChild.id)).toBe(true);
  });

  it('lets focus override pointer and falls back to pointer after focusout', () => {
    const roots = fixtureRoots();
    const controller = roots.find((node) => node.isController);
    const extenders = roots.flatMap((root) => collectNodes(root)).filter((node) => !node.isController);
    const firstChild = extenders[0];
    const secondChild = extenders[1];

    if (controller === undefined || firstChild === undefined || secondChild === undefined) {
      throw new Error('fixture roots missing expected topology');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('editMode', false);
    fixture.detectChanges();

    dispatchNodeEvent(fixture, firstChild.id, 'pointerenter');
    dispatchNodeEvent(fixture, secondChild.id, 'focusin');
    expect(visibleRing(fixture, secondChild.id)).toBe(true);

    dispatchNodeEvent(fixture, secondChild.id, 'focusout');
    expect(visibleRing(fixture, firstChild.id)).toBe(true);
  });

  it('ignores stale pointerleave and clears hover when edit mode starts', () => {
    const roots = fixtureRoots();
    const controller = roots.find((node) => node.isController);
    const extenders = roots.flatMap((root) => collectNodes(root)).filter((node) => !node.isController);
    const firstChild = extenders[0];
    const secondChild = extenders[1];

    if (controller === undefined || firstChild === undefined || secondChild === undefined) {
      throw new Error('fixture roots missing expected topology');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.componentRef.setInput('selectedNodeId', null);
    fixture.componentRef.setInput('editMode', false);
    fixture.detectChanges();

    dispatchNodeEvent(fixture, firstChild.id, 'pointerenter');
    dispatchNodeEvent(fixture, secondChild.id, 'pointerenter');
    dispatchNodeEvent(fixture, firstChild.id, 'pointerleave');
    expect(visibleRing(fixture, secondChild.id)).toBe(true);

    fixture.componentRef.setInput('editMode', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('g.node.selected')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('path.edge.on-path')).toHaveLength(0);
    expect([...fixture.nativeElement.querySelectorAll<SVGRectElement>('rect.selection-ring')]
      .every((ring) => ring.style.display === 'none')).toBe(true);
  });

  it('sweeps disappeared hover targets and does not dim orphan forests', () => {
    const roots = fixtureRoots();
    const controller = roots.find((node) => node.isController);
    const firstChild = roots.flatMap((root) => collectNodes(root)).find((node) => !node.isController);

    if (controller === undefined || firstChild === undefined) {
      throw new Error('fixture roots missing expected topology');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();
    dispatchNodeEvent(fixture, firstChild.id, 'pointerenter');

    const controllerOnly = buildMap([], [], CONTROLLER);

    fixture.componentRef.setInput('roots', controllerOnly);
    fixture.detectChanges();

    const orphan = {...firstChild, id: 'orphan', mac: 'orphan', name: 'Orphan', parent: null, children: []};

    fixture.componentRef.setInput('roots', [...fixtureRoots(), orphan]);
    fixture.detectChanges();
    dispatchNodeEvent(fixture, orphan.id, 'pointerenter');

    expect(visibleRing(fixture, orphan.id)).toBe(true);

    dispatchNodeEvent(fixture, controller.id, 'pointerenter');
    expect(visibleRing(fixture, controller.id)).toBe(true);
  });

  it('clears hover when a node is selected', () => {
    const roots = fixtureRoots();
    const child = roots.flatMap((root) => collectNodes(root)).find((node) => !node.isController);

    if (child === undefined) {
      throw new Error('fixture roots missing child');
    }

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();
    dispatchNodeEvent(fixture, child.id, 'pointerenter');
    dispatchNodeEvent(fixture, child.id, 'click');
    fixture.componentRef.setInput('selectedNodeId', child.id);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('g.node.selected')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('path.edge.on-path').length).toBeGreaterThan(0);
    expect(visibleRing(fixture, child.id)).toBe(true);
  });

  it('marks offline nodes and re-renders on input change without throwing', () => {
    const roots = fixtureRoots();
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const offlineRoots = buildMap(
      normalizeMembers([{cid: 'c-off', mac: 'aa:00:00:00:00:01'}]),
      [],
      CONTROLLER,
    );

    fixture.componentRef.setInput('roots', offlineRoots);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('g.node')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('g.node.offline')).not.toBeNull();
  });

  it('disconnects its ResizeObserver on destroy', () => {
    const disconnect = vi.fn();

    vi.stubGlobal(
      'ResizeObserver',
      class {
        public observe(): void {}
        public disconnect = disconnect;
      },
    );

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();
    fixture.destroy();

    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

function collectNodes(root: MwsNode): MwsNode[] {
  return [root, ...root.children.flatMap((link) => collectNodes(link.node))];
}

function nodeElement(
  fixture: ReturnType<typeof TestBed.createComponent<MwsGraphComponent>>,
  id: string,
): SVGGElement | null {
  return fixture.nativeElement.querySelector(`g.node[data-node-id="${id}"]`);
}

function visibleRing(
  fixture: ReturnType<typeof TestBed.createComponent<MwsGraphComponent>>,
  id: string,
): boolean {
  return nodeElement(fixture, id)?.querySelector<SVGRectElement>('rect.selection-ring')?.style.display !== 'none';
}

function dispatchNodeEvent(
  fixture: ReturnType<typeof TestBed.createComponent<MwsGraphComponent>>,
  id: string,
  type: string,
): void {
  const node = nodeElement(fixture, id);

  if (node === null) {
    throw new Error(`node ${id} not found`);
  }

  node.dispatchEvent(new Event(type, {bubbles: true}));
}
