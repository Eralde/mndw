import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
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
    await resolveComponentResources((url: string) => {
      if (url.endsWith('mws-graph.component.scss')) {
        return Promise.resolve(graphStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [MwsGraphComponent],
      providers: [{provide: TRANSLATOR, useValue: createTestI18n(enCatalog)}],
    }).compileComponents();
  });

  it('renders a group per node and a path per edge without getBBox', () => {
    const fixture = TestBed.createComponent(MwsGraphComponent);

    fixture.componentRef.setInput('roots', fixtureRoots());
    fixture.detectChanges();

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
    expect([...element.querySelectorAll<SVGRectElement>('rect.selection-ring')]
      .every((ring) => ring.style.display === 'none')).toBe(true);
  });

  it('shows the selection ring only on the selected node and moves it when selection changes', () => {
    const roots = fixtureRoots();
    const firstNode = roots[0];
    const secondNode = firstNode?.children[0]?.node;
    const fixture = TestBed.createComponent(MwsGraphComponent);

    expect(firstNode).toBeDefined();
    expect(secondNode).toBeDefined();

    fixture.componentRef.setInput('roots', roots);
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

    extenders[0].mwsdStatus = {state: 'live', lastSuccessAt: Date.now()};
    extenders[1].mwsdStatus = {state: 'stale', lastSuccessAt: Date.now() - 100_000};
    fixture.componentRef.setInput('roots', roots);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const controllerDot = element.querySelector('g.node.controller circle.mwsd-status-dot');

    expect(element.querySelectorAll('circle.mwsd-status-dot')).toHaveLength(3);
    expect(controllerDot).not.toBeNull();
    expect(controllerDot?.style.display).toBe('none');
    expect(element.querySelector('circle.mwsd-status-dot.mwsd-live')).not.toBeNull();
    expect(element.querySelector('circle.mwsd-status-dot.mwsd-stale')).not.toBeNull();
    expect(element.querySelector('g.node.mwsd-live')?.getAttribute('aria-label')).toContain('mwsd live');
    expect(element.querySelector('g.node.mwsd-stale')?.getAttribute('aria-label')).toContain('mwsd stale');

    const updatedRoots = fixtureRoots();
    const updatedExtenders = updatedRoots
      .flatMap((root) => collectNodes(root))
      .filter((node) => !node.isController);

    updatedExtenders[0].mwsdStatus = {state: 'stale', lastSuccessAt: Date.now() - 100_000};
    updatedExtenders[1].mwsdStatus = {state: 'offline', lastSuccessAt: null};
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
      'persistent session live',
    );
    expect(element.querySelector('g.node.persistent-failing')?.getAttribute('aria-label')).toContain(
      'persistent session failing',
    );
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
