import '@angular/compiler';
import {signal, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeMembers} from '../api/normalize';
import {buildMap} from '../domain/mws/map-builder';
import type {MwsNode} from '../domain/mws/mws.types';
import {loadFixture} from '../fixtures/load';
import {MwsDataService, type MwsViewPhase} from '../services/mws-data.service';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {MWS_MOCK_OPTIONS, PLUGIN_STORAGE} from '../tokens';
import {NodePositionStore} from '../services/node-position.store';
import graphStyles from '../components/mws-graph/mws-graph.component.scss?raw';
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

function render(data: FakeData): ReturnType<typeof TestBed.createComponent<AppComponent>> {
  TestBed.overrideProvider(MwsDataService, {useValue: data});

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

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        {provide: MwsDataService, useValue: undefined},
        {provide: PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        NodePositionStore,
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

  it('shows the unsupported and empty states', () => {
    const unsupported = fakeData('unsupported');

    expect((render(unsupported).nativeElement as HTMLElement).textContent).toContain('not an MWS controller');
  });

  it('shows the empty state', () => {
    const empty = fakeData('empty');

    expect((render(empty).nativeElement as HTMLElement).textContent).toContain('No extenders found');
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
