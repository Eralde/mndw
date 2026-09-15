import '@angular/compiler';
import {DestroyRef, inject, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {createTranslatorSignals} from '@mndw/sdk/angular';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeMembers} from '../../api/normalize';
import {buildMap} from '../../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../../domain/mws/mws.types';
import {loadFixture} from '../../fixtures/load';
import {DEFAULT_LAYOUT_CONFIG} from './graph-layout';
import {MwsGraphComponent} from './mws-graph.component';
import graphStyles from './mws-graph.component.scss?raw';
import {TRANSLATOR} from '../../tokens';
import enCatalog from '../../../i18n/en.json';
import ruCatalog from '../../../i18n/ru.json';

let testI18n = createTestI18n(enCatalog);

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

describe('MwsGraphComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    testI18n = createTestI18n(enCatalog);
    await resolveComponentResources((url: string) => {
      if (url.endsWith('mws-graph.component.scss')) {
        return Promise.resolve(graphStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [MwsGraphComponent],
      providers: [{
        provide: TRANSLATOR,
        useFactory: () => createTranslatorSignals(testI18n, inject(DestroyRef)),
      }],
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

  it('renders accessible mwsd dots for extenders and updates state without topology changes', () => {
    const roots = fixtureRoots();
    const extenders = roots
      .flatMap((root) => collectNodes(root))
      .filter((node) => !node.isController);
    const fixture = TestBed.createComponent(MwsGraphComponent);

    extenders[0].mwsdStatus = {state: 'live', lastTelemetryAt: Date.now()};
    extenders[1].mwsdStatus = {state: 'stale', lastTelemetryAt: Date.now() - 100_000};
    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const controllerDot = element.querySelector('g.node.controller circle.mwsd-status-dot');

    expect(element.querySelectorAll('circle.mwsd-status-dot')).toHaveLength(3);
    expect(controllerDot).not.toBeNull();
    expect(controllerDot?.style.display).toBe('none');
    expect(element.querySelector('circle.mwsd-status-dot.mwsd-live')).not.toBeNull();
    expect(element.querySelector('circle.mwsd-status-dot.mwsd-stale')).not.toBeNull();
    expect(element.querySelector('g.node.mwsd-live')?.getAttribute('aria-label')).toContain('Telemetry: live');
    expect(element.querySelector('g.node.mwsd-stale')?.getAttribute('aria-label')).toContain('Telemetry: stale');
    expect(element.querySelector('circle.mwsd-status-dot.mwsd-live title')?.textContent).toBe('Telemetry: live');
    expect(element.querySelector('circle.mwsd-status-dot.mwsd-stale title')?.textContent).toBe('Telemetry: stale');

    const updatedRoots = fixtureRoots();
    const updatedExtenders = updatedRoots
      .flatMap((root) => collectNodes(root))
      .filter((node) => !node.isController);

    updatedExtenders[0].mwsdStatus = {state: 'stale', lastTelemetryAt: Date.now() - 100_000};
    updatedExtenders[1].mwsdStatus = {state: 'offline', lastTelemetryAt: null};
    fixture.componentRef.setInput('roots', updatedRoots);
    fixture.detectChanges();

    expect(element.querySelector('circle.mwsd-status-dot.mwsd-live')).toBeNull();
    expect(element.querySelectorAll('circle.mwsd-status-dot.mwsd-stale')).toHaveLength(1);
    expect(element.querySelectorAll('circle.mwsd-status-dot.mwsd-offline')).toHaveLength(1);
  });

  it('renders persistent-session state only for configured extenders', () => {
    const roots = fixtureRoots();
    const nodes = roots.flatMap((root) => collectNodes(root));
    const extenders = nodes.filter((node) => !node.isController);

    extenders[0].persistentSession = true;
    extenders[1].persistentSession = false;

    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const dots = element.querySelectorAll('circle.persistent-session-dot');

    expect(dots).toHaveLength(nodes.length);
    expect(element.querySelector('circle.persistent-session-dot.persistent-live')).not.toBeNull();
    expect(element.querySelector('circle.persistent-session-dot.persistent-failing')).not.toBeNull();
    expect(element.querySelector('g.node.controller circle.persistent-session-dot')?.style.display).toBe('none');
    expect(element.querySelector('g.node.persistent-live')?.getAttribute('aria-label')).toContain(
      'Remote control: connected',
    );
    expect(element.querySelector('g.node.persistent-failing')?.getAttribute('aria-label')).toContain(
      'Remote control: disconnected',
    );
    expect(element.querySelector('circle.persistent-session-dot.persistent-live title')?.textContent)
      .toBe('Remote control: connected');
    expect(element.querySelector('circle.persistent-session-dot.persistent-failing title')?.textContent)
      .toBe('Remote control: disconnected');
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
