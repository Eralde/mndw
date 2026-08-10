import '@angular/compiler';
import {signal, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {PageRoute} from '@mndw/sdk';
import {BehaviorSubject} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeMembers} from '../api/normalize';
import {buildMap} from '../domain/mws/map-builder';
import type {MwsNode} from '../domain/mws/mws.types';
import {loadFixture} from '../fixtures/load';
import {MwsDataService, type MwsViewPhase} from '../services/mws-data.service';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {NodeTableColumnsStore} from '../services/node-table-columns.store';
import {MWS_MOCK_OPTIONS, MWS_PAGE_ROUTE, PLUGIN_STORAGE, SHARED_PLUGIN_STORAGE} from '../tokens';
import {NodePositionStore} from '../services/node-position.store';
import graphStyles from '../components/mws-graph/mws-graph.component.scss?raw';
import clientsTableStyles from '../components/clients-table/clients-table.component.scss?raw';
import clientsTableTemplate from '../components/clients-table/clients-table.component.html?raw';
import nodesTableStyles from '../components/nodes-table/nodes-table.component.scss?raw';
import nodesTableTemplate from '../components/nodes-table/nodes-table.component.html?raw';
import appStyles from './app.component.scss?raw';
import appTemplate from './app.component.html?raw';
import {AppComponent} from './app.component';

interface FakeData {
  phase: ReturnType<typeof signal<MwsViewPhase>>;
  roots: ReturnType<typeof signal<MwsNode[]>>;
  pollError: ReturnType<typeof signal<boolean>>;
  lastUpdatedAt: ReturnType<typeof signal<number | null>>;
  freshnessNow: ReturnType<typeof signal<number>>;
  start: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function fakeData(phase: MwsViewPhase, roots: MwsNode[] = []): FakeData {
  return {
    phase: signal<MwsViewPhase>(phase),
    roots: signal<MwsNode[]>(roots),
    pollError: signal(false),
    lastUpdatedAt: signal<number | null>(null),
    freshnessNow: signal(Date.now()),
    start: vi.fn(),
    retry: vi.fn(),
  };
}

function render(
  data: FakeData,
  pageRoute?: PageRoute,
): ReturnType<typeof TestBed.createComponent<AppComponent>> {
  TestBed.overrideProvider(MwsDataService, {useValue: data});

  if (pageRoute !== undefined) {
    TestBed.overrideProvider(MWS_PAGE_ROUTE, {useValue: pageRoute});
  }

  const fixture = TestBed.createComponent(AppComponent);

  fixture.componentRef.setInput('openNodeDrawer', vi.fn());
  fixture.detectChanges();

  return fixture;
}

function fixtureRoots(): MwsNode[] {
  return buildMap(normalizeMembers(loadFixture('show-mws-member.json')), [], {
    mac: '02:7d:4a:91:c3:10',
    ip: null,
    name: 'Router',
    model: null,
    firmware: null,
    interfaceUptime: null,
    isOnline: true,
  });
}

describe('AppComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
    await resolveComponentResources((url: string) => {
      if (url.endsWith('app.component.html')) {
        return Promise.resolve(appTemplate);
      }

      if (url.endsWith('app.component.scss')) {
        return Promise.resolve(appStyles);
      }

      if (url.endsWith('mws-graph.component.scss')) {
        return Promise.resolve(graphStyles);
      }

      if (url.endsWith('clients-table.component.html')) {
        return Promise.resolve(clientsTableTemplate);
      }

      if (url.endsWith('clients-table.component.scss')) {
        return Promise.resolve(clientsTableStyles);
      }

      if (url.endsWith('nodes-table.component.html')) {
        return Promise.resolve(nodesTableTemplate);
      }

      if (url.endsWith('nodes-table.component.scss')) {
        return Promise.resolve(nodesTableStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        {provide: MwsDataService, useValue: undefined},
        {provide: PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        {provide: SHARED_PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        NodePositionStore,
        NodeTableColumnsStore,
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('starts the data service and shows the loading state', () => {
    const data = fakeData('loading');
    const fixture = render(data);

    expect(data.start).toHaveBeenCalledOnce();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Loading');
  });

  it('shows the retry button in the error state and wires it to retry()', () => {
    const data = fakeData('error');
    const fixture = render(data);
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.state mndw-button');

    button?.click();
    expect(data.retry).toHaveBeenCalledOnce();
  });

  it('shows the unsupported state', () => {
    const unsupported = fakeData('unsupported');

    expect((render(unsupported).nativeElement as HTMLElement).textContent).toContain('not an MWS controller');
  });

  it('renders a controller-only map when no extenders are ready', () => {
    const controllerOnly = fakeData(
      'ready',
      buildMap([], [], {
        mac: '02:7d:4a:91:c3:10',
        ip: null,
        name: 'Router',
        model: null,
        firmware: null,
        interfaceUptime: null,
        isOnline: true,
      }),
    );
    const element = render(controllerOnly).nativeElement as HTMLElement;

    expect(element.querySelector('mws-map-graph')).not.toBeNull();
    expect(element.textContent).not.toContain('No extenders found');
  });

  it('renders the graph when ready and opens the drawer on node selection', () => {
    const data = fakeData('ready', fixtureRoots());
    const fixture = render(data);
    const open = fixture.componentInstance.openNodeDrawer as ReturnType<typeof vi.fn>;
    const node = (fixture.nativeElement as HTMLElement).querySelector<SVGGElement>('g.node');

    expect(node).not.toBeNull();
    node?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(open).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Function));
  });

  it('renders Map, Nodes, and Clients tabs when ready', () => {
    const fixture = render(fakeData('ready', fixtureRoots()));
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('mndw-tabs.map-tabs')).not.toBeNull();
    expect(element.querySelectorAll('mndw-tab')).toHaveLength(3);
    expect(element.querySelector('mndw-tab#map')?.textContent).toContain('Map');
    expect(element.querySelector('mndw-tab#nodes')?.textContent).toContain('Nodes');
    expect(element.querySelector('mndw-tab#clients')?.textContent).toContain('Clients');
    expect(element.querySelector('mndw-tab-panel[for="map"] mws-map-graph')).not.toBeNull();
    expect(element.querySelector('mndw-tab-panel[for="nodes"] mws-nodes-table')).not.toBeNull();
    expect(element.querySelector('mndw-tab-panel[for="clients"] mws-clients-table')).not.toBeNull();
  });

  it('maps the Nodes child path and tab change to /nodes', () => {
    const childPath$ = new BehaviorSubject('/nodes');
    const navigate = vi.fn(() => Promise.resolve(undefined));
    const pageRoute = {childPath$, navigate} as unknown as PageRoute;
    const fixture = render(fakeData('ready', fixtureRoots()), pageRoute);
    const tabs = fixture.nativeElement.querySelector('mndw-tabs') as HTMLElement & {value: string};

    expect(tabs.value).toBe('nodes');

    tabs.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'nodes'}}));
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith('/nodes');
  });

  it('shares Nodes activation with map selection and the drawer', () => {
    const fixture = render(fakeData('ready', fixtureRoots()));
    const open = fixture.componentInstance.openNodeDrawer as ReturnType<typeof vi.fn>;
    const button = fixture.nativeElement.querySelector<HTMLButtonElement>(
      'mws-nodes-table tbody td.node-name button[aria-label="Open Router"]',
    );

    button?.click();
    fixture.detectChanges();

    expect(open).toHaveBeenCalledWith('02:7d:4a:91:c3:10', 'Router', expect.any(Function));
    expect(fixture.nativeElement.querySelector('mws-map-graph g.node.selected')).not.toBeNull();
  });

  it('maps page child paths to tabs and navigates tab changes', () => {
    const childPath$ = new BehaviorSubject('/clients');
    const navigate = vi.fn(() => Promise.resolve(undefined));
    const pageRoute = {childPath$, navigate} as unknown as PageRoute;
    const fixture = render(fakeData('ready', fixtureRoots()), pageRoute);
    const tabs = fixture.nativeElement.querySelector('mndw-tabs') as HTMLElement & {value: string};

    expect(tabs.value).toBe('clients');

    tabs.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'map'}}));
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith('/topology');
    expect(tabs.value).toBe('map');
  });

  it('maps root and unknown child paths to Map', () => {
    const childPath$ = new BehaviorSubject('/unknown');
    const pageRoute = {childPath$, navigate: vi.fn(() => Promise.resolve(undefined))} as unknown as PageRoute;
    const fixture = render(fakeData('ready', fixtureRoots()), pageRoute);
    const tabs = fixture.nativeElement.querySelector('mndw-tabs') as HTMLElement & {value: string};

    expect(tabs.value).toBe('map');

    childPath$.next('');
    fixture.detectChanges();

    expect(tabs.value).toBe('map');
  });

  it('replaces the base route with the default topology child route', () => {
    const childPath$ = new BehaviorSubject('');
    const navigate = vi.fn(() => Promise.resolve(undefined));
    const pageRoute = {childPath$, navigate} as unknown as PageRoute;

    render(fakeData('ready', fixtureRoots()), pageRoute);

    expect(navigate).toHaveBeenCalledWith('/topology', {replace: true});
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe or navigate when optional page route is absent', () => {
    const fixture = render(fakeData('ready', fixtureRoots()));
    const tabs = fixture.nativeElement.querySelector('mndw-tabs') as HTMLElement & {value: string};

    tabs.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, detail: {value: 'clients'}}));
    fixture.detectChanges();

    expect(tabs.value).toBe('clients');
  });

  it('unsubscribes from page child paths during teardown', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => ({unsubscribe}));
    const pageRoute = {
      childPath$: {subscribe},
      navigate: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as PageRoute;
    const fixture = render(fakeData('ready', fixtureRoots()), pageRoute);

    fixture.destroy();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('shows the non-blocking banner when pollError is set', () => {
    const data = fakeData('ready', fixtureRoots());

    data.pollError.set(true);

    const fixture = render(data);

    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull();
  });

  it('labels large mock mode with its generated size', () => {
    const data = fakeData('ready', fixtureRoots());

    TestBed.overrideProvider(MWS_MOCK_OPTIONS, {useValue: {mode: 'large', extenders: 20, clients: 100}});

    const fixture = render(data);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Mock data: 20 extenders · 100 clients');
  });
});
