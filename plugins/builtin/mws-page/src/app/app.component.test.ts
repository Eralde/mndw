import '@angular/compiler';
import {DestroyRef, inject, signal, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {OverlayCloseEvent, OverlayLayer, OverlayService, PageRoute} from '@mndw/sdk';
import {createTranslatorSignals} from '@mndw/sdk/angular';
import {createTestI18n} from '@mndw/sdk/testing';
import {BehaviorSubject} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeMembers} from '../api/normalize';
import {buildMap} from '../domain/mws/map-builder';
import type {MwsNode} from '../domain/mws/mws.types';
import {loadFixture} from '../fixtures/load';
import {ExtraFeaturesBannerStore} from '../services/extra-features-banner.store';
import {
  type ExtraFeaturesAvailability,
  type ExtraFeaturesPresentation,
  type ExtraFeaturesSetupReason,
  MwsDataService,
  type MwsViewPhase,
} from '../services/mws-data.service';
import {FakePluginStorage} from '../test-support/plugin-storage.fake';
import {NodeTableColumnsStore} from '../services/node-table-columns.store';
import {MWS_MOCK_OPTIONS, MWS_PAGE_ROUTE, OVERLAY, PLUGIN_STORAGE, SHARED_PLUGIN_STORAGE, TRANSLATOR} from '../tokens';
import {NodePositionStore} from '../services/node-position.store';
import graphStyles from '../components/mws-graph/mws-graph.component.scss?raw';
import clientsTableStyles from '../components/clients-table/clients-table.component.scss?raw';
import clientsTableTemplate from '../components/clients-table/clients-table.component.html?raw';
import nodesTableStyles from '../components/nodes-table/nodes-table.component.scss?raw';
import nodesTableTemplate from '../components/nodes-table/nodes-table.component.html?raw';
import appStyles from './app.component.scss?raw';
import appTemplate from './app.component.html?raw';
import {AppComponent} from './app.component';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';

interface FakeData {
  phase: ReturnType<typeof signal<MwsViewPhase>>;
  roots: ReturnType<typeof signal<MwsNode[]>>;
  pollError: ReturnType<typeof signal<boolean>>;
  extraFeaturesAvailability: ReturnType<typeof signal<ExtraFeaturesAvailability>>;
  extraFeaturesPresentation: ReturnType<typeof signal<ExtraFeaturesPresentation>>;
  extraFeaturesSetupReasons: ReturnType<typeof signal<ExtraFeaturesSetupReason[]>>;
  lastUpdatedAt: ReturnType<typeof signal<number | null>>;
  freshnessNow: ReturnType<typeof signal<number>>;
  start: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

let testI18n = createTestI18n(enCatalog);

function fakeData(phase: MwsViewPhase, roots: MwsNode[] = []): FakeData {
  return {
    phase: signal<MwsViewPhase>(phase),
    roots: signal<MwsNode[]>(roots),
    pollError: signal(false),
    extraFeaturesAvailability: signal<ExtraFeaturesAvailability>('active'),
    extraFeaturesPresentation: signal<ExtraFeaturesPresentation>('active'),
    extraFeaturesSetupReasons: signal<ExtraFeaturesSetupReason[]>([]),
    lastUpdatedAt: signal<number | null>(null),
    freshnessNow: signal(Date.now()),
    start: vi.fn(),
    retry: vi.fn(),
  };
}

function render(
  data: FakeData,
  pageRoute?: PageRoute,
  openNodeDrawer: ReturnType<typeof vi.fn> = vi.fn(),
): ReturnType<typeof TestBed.createComponent<AppComponent>> {
  TestBed.overrideProvider(MwsDataService, {useValue: data});

  if (pageRoute !== undefined) {
    TestBed.overrideProvider(MWS_PAGE_ROUTE, {useValue: pageRoute});
  }

  const fixture = TestBed.createComponent(AppComponent);

  fixture.componentRef.setInput('openNodeDrawer', openNodeDrawer);
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
  it('updates root and child probes after a locale switch without recreation', () => {
    const fixture = render(fakeData('ready', fixtureRoots()));
    const rootProbe = fixture.nativeElement.querySelector<HTMLElement>('[data-testid="l10n-probe"]');
    const childProbe = fixture.nativeElement.querySelector<HTMLElement>('[data-testid="l10n-child-probe"]');

    expect(rootProbe?.textContent).toBe('MWS English probe');
    expect(childProbe?.textContent).toBe('MWS English probe');
    testI18n.setLocale('ru', ruCatalog);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="l10n-probe"]')).toBe(rootProbe);
    expect(fixture.nativeElement.querySelector('[data-testid="l10n-child-probe"]')).toBe(childProbe);
    expect(rootProbe?.textContent).toBe('Проба MWS');
    expect(childProbe?.textContent).toBe('Проба MWS');
  });

  beforeEach(async () => {
    TestBed.resetTestingModule();
    testI18n = createTestI18n(enCatalog);
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
        ExtraFeaturesBannerStore,
        {provide: PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        {provide: SHARED_PLUGIN_STORAGE, useValue: new FakePluginStorage()},
        {provide: OVERLAY, useValue: {open: vi.fn(), closeAll: vi.fn()}},
        {provide: TRANSLATOR, useFactory: () => createTranslatorSignals(testI18n, inject(DestroyRef))},
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
    const open = vi.fn();
    const fixture = render(data, undefined, open);
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

  it('renders discrete summary chips and keeps map freshness separate from telemetry', () => {
    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    controller.isOnline = false;
    controller.fw = '5.2';
    controller.fwAvailable = '5.3';
    controller.clients.push({
      mac: 'client-1',
      name: 'Client 1',
      ip: null,
      uptime: null,
      lastSeen: null,
      wired: false,
    });

    const data = fakeData('ready', roots);
    const now = Date.now();

    data.lastUpdatedAt.set(now - 5_000);
    data.freshnessNow.set(now);

    const element = render(data).nativeElement as HTMLElement;
    const chips = [...element.querySelectorAll<HTMLElement>('.summary-chip')];

    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
      '3 nodes',
      '1 offline',
      '1 client',
      '1 update available',
      'Map updated 5s ago',
    ]);
  });

  it('routes summary filter chips to Nodes and toggles their active state', () => {
    const navigate = vi.fn(() => Promise.resolve(undefined));
    const pageRoute = {
      childPath$: new BehaviorSubject('/topology'),
      navigate,
    } as unknown as PageRoute;
    const roots = fixtureRoots();

    if (roots[0] !== undefined) {
      roots[0].isOnline = false;
    }

    const fixture = render(fakeData('ready', roots), pageRoute);
    const chip = fixture.nativeElement.querySelector<HTMLElement>('[data-filter="offline"]');

    chip?.click();
    fixture.detectChanges();

    expect(chip?.getAttribute('aria-pressed')).toBe('true');
    expect((fixture.nativeElement.querySelector('mndw-tabs') as HTMLElement & {value: string}).value).toBe('nodes');
    expect(navigate).toHaveBeenCalledWith('/nodes');

    chip?.click();
    fixture.detectChanges();

    expect(chip?.getAttribute('aria-pressed')).toBe('false');
  });

  it('clears positions only after auto-layout confirmation', async () => {
    const clear = vi.fn(() => Promise.resolve());
    const overlay = {
      open: vi.fn(() => ({closed: Promise.resolve({reason: 'action', result: 'confirm'})})),
    };

    TestBed.overrideProvider(OVERLAY, {useValue: overlay});

    const fixture = render(fakeData('ready', fixtureRoots()));
    const positions = fixture.componentInstance.positions;

    vi.spyOn(positions, 'clear').mockImplementation(clear);
    await (fixture.componentInstance as unknown as {autoLayout: () => Promise<void>}).autoLayout();

    expect(overlay.open).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('does not clear positions after auto-layout cancellation or host dismissal', async () => {
    const clear = vi.fn(() => Promise.resolve());
    const overlay = {
      open: vi.fn(() => ({closed: Promise.resolve({reason: 'escape'})})),
    };

    TestBed.overrideProvider(OVERLAY, {useValue: overlay});

    const fixture = render(fakeData('ready', fixtureRoots()));

    vi.spyOn(fixture.componentInstance.positions, 'clear').mockImplementation(clear);
    await (fixture.componentInstance as unknown as {autoLayout: () => Promise<void>}).autoLayout();

    expect(clear).not.toHaveBeenCalled();
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

  it('shares Nodes activation with map selection and the drawer', async () => {
    const open = vi.fn();
    const fixture = render(fakeData('ready', fixtureRoots()), undefined, open);
    const table = fixture.nativeElement.querySelector('mndw-table') as HTMLElement & {updateComplete: Promise<unknown>};

    await table.updateComplete;

    const button = fixture.nativeElement.querySelector<HTMLButtonElement>(
      'mws-nodes-table button.node-name[aria-label="Open Router"]',
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

  it.each(
    [
      ['checking', 'Checking extra features…', 'extra-features-badge--info'],
      ['active', 'Extra features active', 'extra-features-badge--success'],
      ['starting', 'Extra features starting…', 'extra-features-badge--info'],
      ['unavailable', 'Extra features unavailable', 'extra-features-badge--neutral'],
      ['limited', 'Extra features temporarily unavailable', 'extra-features-badge--neutral'],
      ['blocked', 'Extra features need access', 'extra-features-badge--neutral'],
      ['incompatible', 'Extra features need an update', 'extra-features-badge--warning'],
    ] as const,
  )('renders %s badge text and semantic tone', (state, text, tone) => {
    const data = fakeData('ready', fixtureRoots());

    data.extraFeaturesPresentation.set(state);

    const fixture = render(data);
    const badge = fixture.nativeElement.querySelector<HTMLButtonElement>('.extra-features-badge');

    expect(badge?.textContent).toContain(text);
    expect(badge?.classList.contains(tone)).toBe(true);
    expect(badge?.getAttribute('aria-expanded')).toBe('false');
  });

  it('offers retry when starting takes longer than expected', () => {
    const data = fakeData('ready', fixtureRoots());

    data.extraFeaturesPresentation.set('taking-longer');

    const fixture = render(data);
    const banner = fixture.nativeElement.querySelector<HTMLElement>('.extra-features-taking-longer');

    expect(banner?.textContent).toContain('taking longer than expected');
    banner?.querySelector('mndw-button')?.dispatchEvent(new Event('click', {bubbles: true}));
    expect(data.retry).toHaveBeenCalledOnce();
  });

  it('shows and dismisses the unavailable setup banner after storage load', async () => {
    const data = fakeData('ready', fixtureRoots());

    data.extraFeaturesPresentation.set('unavailable');

    const fixture = render(data);

    await vi.waitFor(() => {
      expect(fixture.nativeElement.querySelector('.extra-features-setup')).not.toBeNull();
    });

    const banner = fixture.nativeElement.querySelector<HTMLElement>('.extra-features-setup');

    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.querySelector('a[href="/settings/general"]')).not.toBeNull();
    banner?.querySelector<HTMLButtonElement>('[data-action="dismiss-extra-features"]')?.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.extra-features-setup')).toBeNull();
  });

  it('does not show setup banner when unavailable state has no extenders', async () => {
    const roots = fixtureRoots();
    const controller = roots[0];

    if (controller === undefined) {
      throw new Error('fixture roots missing controller');
    }

    const data = fakeData('ready', [{...controller, children: []}]);

    data.extraFeaturesPresentation.set('unavailable');

    const fixture = render(data);

    await vi.waitFor(() =>
      expect(
        (fixture.componentInstance as unknown as {bannerStore: {loaded: () => boolean}}).bannerStore.loaded(),
      ).toBe(true)
    );

    expect(fixture.nativeElement.querySelector('.extra-features-setup')).toBeNull();
  });

  it('uses extender-session setup copy when extender authentication is missing', async () => {
    const data = fakeData('ready', fixtureRoots());

    data.extraFeaturesPresentation.set('unavailable');
    data.extraFeaturesSetupReasons.set(['extender-session']);

    const fixture = render(data);

    await vi.waitFor(() => expect(fixture.nativeElement.querySelector('.extra-features-setup')).not.toBeNull());

    expect((fixture.nativeElement.querySelector('.extra-features-setup') as HTMLElement).textContent)
      .toContain('Configure authenticated extender sessions');
  });

  it('replaces setup banner with non-dismissible limited status', async () => {
    const data = fakeData('ready', fixtureRoots());

    data.extraFeaturesPresentation.set('unavailable');

    const fixture = render(data);

    await vi.waitFor(() => expect(fixture.nativeElement.querySelector('.extra-features-setup')).not.toBeNull());
    data.extraFeaturesAvailability.set('limited');
    data.extraFeaturesPresentation.set('limited');
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector<HTMLElement>('.extra-features-limited');

    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toContain('Extra features are temporarily unavailable. Retrying…');
    expect(status?.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.querySelector('.extra-features-setup')).toBeNull();
  });

  it('does not show limited retry status when current availability is blocked', () => {
    const data = fakeData('ready', fixtureRoots());

    data.extraFeaturesAvailability.set('blocked');
    data.extraFeaturesPresentation.set('limited');

    const fixture = render(data);

    expect(fixture.nativeElement.querySelector('.extra-features-limited')).toBeNull();
  });

  it('opens against the badge, updates from immediate truth, and closes on dismissal or destroy', async () => {
    let resolveClosed: (event: OverlayCloseEvent) => void = () => undefined;
    const closed = new Promise<OverlayCloseEvent>((resolve) => {
      resolveClosed = resolve;
    });
    const contentElement = document.createElement('div');
    const layer = {
      hostElement: document.createElement('div'),
      contentElement,
      isOpen: true,
      state: 'open',
      signal: new AbortController().signal,
      closed,
      close: vi.fn(),
      setCleanup: vi.fn(),
      markReady: vi.fn(),
      update: vi.fn(),
      onClose: vi.fn(() => () => undefined),
    } as unknown as OverlayLayer;
    const secondClose = vi.fn();
    const secondLayer = {
      ...layer,
      closed: new Promise<OverlayCloseEvent>(() => undefined),
      close: secondClose,
    } as unknown as OverlayLayer;
    let layerNumber = 0;
    const overlay = {
      createLayer: vi.fn(() => {
        layerNumber += 1;

        return layerNumber === 1 ? layer : secondLayer;
      }),
      open: vi.fn(),
      closeAll: vi.fn(),
    };

    TestBed.overrideProvider(OVERLAY, {useValue: overlay as unknown as OverlayService});

    const data = fakeData('ready', fixtureRoots());
    const fixture = render(data);
    const badge = fixture.nativeElement.querySelector<HTMLButtonElement>('.extra-features-badge');

    badge?.click();
    fixture.detectChanges();
    expect(overlay.createLayer).toHaveBeenCalledWith(expect.objectContaining({anchor: {element: badge}}));
    expect(badge?.getAttribute('aria-expanded')).toBe('true');

    data.extraFeaturesAvailability.set('limited');
    fixture.detectChanges();
    expect(contentElement.textContent).toContain('Features are temporarily unreachable');

    resolveClosed({reason: 'escape'});
    await Promise.resolve();
    fixture.detectChanges();
    expect(badge?.getAttribute('aria-expanded')).toBe('false');

    badge?.click();
    fixture.destroy();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('labels large mock mode with its generated size', () => {
    const data = fakeData('ready', fixtureRoots());

    TestBed.overrideProvider(MWS_MOCK_OPTIONS, {useValue: {mode: 'large', extenders: 20, clients: 100}});

    const fixture = render(data);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Mock data: 20 extenders · 100 clients');
  });
});
