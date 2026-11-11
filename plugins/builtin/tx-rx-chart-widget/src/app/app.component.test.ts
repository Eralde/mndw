import '@angular/compiler';
import {DestroyRef, inject, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {createTranslatorSignals} from '@mndw/sdk/angular';
import {createTestI18n} from '@mndw/sdk/testing';
import {type ComponentFixture, TestBed} from '@angular/core/testing';
import type {PluginRciManager, PluginStorage} from '@mndw/sdk';
import type {RrdResponse} from '@mndw/sdk/rrd';
import type {RciQuery} from '@rci-tools/core';
import {type Observable, Subject, type Subscription, of, throwError} from 'rxjs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OpenSettingsFn} from '../open-settings-dialog';
import {PLUGIN_STORAGE, RCI_MANAGER, TRANSLATOR} from '../tokens';
import type {ClockDate} from '../types/rci.types';
import appStyles from './app.component.scss?raw';
import appTemplate from './app.component.html?raw';
import {AppComponent as AppComponentType} from './app.component';
import enCatalog from '../../i18n/en.json';
import ruCatalog from '../../i18n/ru.json';

const interfaces = {
  eth0: {id: 'eth0', description: 'LAN', traits: ['Ip']},
  eth1: {id: 'eth1', description: 'WAN', traits: ['Ip']},
};

const clockDate: ClockDate = {weekday: 1, day: 1, month: 1, year: 2026, hour: 12, min: 0, sec: 0, msec: 0};
const rrdPair = (t: number, txValue: number, rxValue: number): [RrdResponse, RrdResponse] => [
  {data: [{t, v: txValue}]},
  {data: [{t, v: rxValue}]},
];

let fixtures: ComponentFixture<AppComponentType>[] = [];

function fakeManager(rrdResponses?: Subject<[RrdResponse, RrdResponse]>): PluginRciManager {
  return {
    queue: (query: RciQuery | RciQuery[]) => {
      const path = Array.isArray(query) ? query[0]?.path : query.path;

      if (path === 'show.interface') {
        return of(interfaces);
      }

      if (path === 'show.clock.date') {
        return of({weekday: 1, day: 1, month: 1, year: 2026, hour: 12, min: 0, sec: 0, msec: 0});
      }

      if (path === 'show.interface.rrd' && rrdResponses !== undefined) {
        return rrdResponses.asObservable();
      }

      return of([{data: []}, {data: []}]);
    },
  } as unknown as PluginRciManager;
}

function fakeStorage(savedInterface: string | null, savedRefresh: string | null): PluginStorage {
  return {
    get: vi.fn((key: string) =>
      Promise.resolve(
        key === 'tx-rx-rrd-chart-interface' ? savedInterface : savedRefresh,
      )
    ),
    set: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  } as unknown as PluginStorage;
}

function sequencedManager(
  rrd: (call: number) => Observable<[RrdResponse, RrdResponse]> = () => of([{data: []}, {data: []}]),
  deviceTime: (call: number) => Observable<ClockDate> = () => of(clockDate),
): {
  manager: PluginRciManager;
  paths: string[];
  rrdCalls: () => number;
  deviceTimeCalls: () => number;
} {
  const paths: string[] = [];
  let rrdCount = 0;
  let deviceTimeCount = 0;

  const manager = {
    queue: (query: RciQuery | RciQuery[]) => {
      const first = Array.isArray(query) ? query[0] : query;
      const path = first?.path ?? '';

      paths.push(path);

      if (path === 'show.interface') {
        return of(interfaces);
      }

      if (path === 'show.clock.date') {
        deviceTimeCount += 1;

        return deviceTime(deviceTimeCount);
      }

      if (path === 'show.interface.rrd') {
        rrdCount += 1;

        return rrd(rrdCount);
      }

      return of([{data: []}, {data: []}]);
    },
  } as unknown as PluginRciManager;

  return {manager, paths, rrdCalls: () => rrdCount, deviceTimeCalls: () => deviceTimeCount};
}

function manualRrdManager(): {
  manager: PluginRciManager;
  requests: Array<{interfaceId: string; response: Subject<[RrdResponse, RrdResponse]>}>;
} {
  const requests: Array<{interfaceId: string; response: Subject<[RrdResponse, RrdResponse]>}> = [];

  const manager = {
    queue: (query: RciQuery | RciQuery[]) => {
      const first = Array.isArray(query) ? query[0] : query;

      if (first?.path === 'show.interface') {
        return of(interfaces);
      }

      if (first?.path === 'show.clock.date') {
        return of(clockDate);
      }

      if (first?.path === 'show.interface.rrd') {
        const interfaceId = String((first.data as {name?: string} | undefined)?.name ?? '');
        const response = new Subject<[RrdResponse, RrdResponse]>();

        requests.push({interfaceId, response});

        return response.asObservable();
      }

      return of([{data: []}, {data: []}]);
    },
  } as unknown as PluginRciManager;

  return {manager, requests};
}

function queryElement<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

async function flushFirstPoll(fixture: ComponentFixture<AppComponentType>): Promise<void> {
  await vi.waitFor(() => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mndw-line-chart')).not.toBeNull();
  });
}

async function createFixture(
  savedInterface: string | null,
  savedRefresh: string | null,
  setTileTitle?: ((title: string) => void) | null,
  i18n = createTestI18n(enCatalog),
  manager = fakeManager(),
  storage?: PluginStorage,
): Promise<
  {
    fixture: ComponentFixture<AppComponentType>;
    openSettings: ReturnType<typeof vi.fn>;
    setTileTitle: ((title: string) => void) | undefined;
  }
> {
  await resolveComponentResources((url: string) => {
    if (url.endsWith('app.component.html')) {
      return Promise.resolve(appTemplate);
    }

    if (url.endsWith('app.component.scss')) {
      return Promise.resolve(appStyles);
    }

    throw new Error(`resource URL: ${url}`);
  });

  const openSettings = vi.fn<OpenSettingsFn>();
  const setTileTitleInput = setTileTitle === null ? undefined : (setTileTitle ?? vi.fn<(title: string) => void>());

  await TestBed.configureTestingModule({
    imports: [AppComponentType],
    providers: [
      {provide: RCI_MANAGER, useValue: manager},
      {provide: PLUGIN_STORAGE, useValue: storage ?? fakeStorage(savedInterface, savedRefresh)},
      {provide: TRANSLATOR, useFactory: () => createTranslatorSignals(i18n, inject(DestroyRef))},
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(AppComponentType);
  const instance = fixture.componentInstance as unknown as {
    openSettings: () => OpenSettingsFn;
    setTileTitle: () => ((title: string) => void) | undefined;
  };

  instance.openSettings = () => openSettings;
  instance.setTileTitle = () => setTileTitleInput;
  fixtures.push(fixture);

  return {fixture, openSettings, setTileTitle: setTileTitleInput};
}

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.destroy();
  }

  fixtures = [];
  TestBed.resetTestingModule();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AppComponent', () => {
  it('updates the same probe after a locale switch', async () => {
    const i18n = createTestI18n(enCatalog);
    const {fixture} = await createFixture(null, null, undefined, i18n);

    fixture.detectChanges();

    const probe = fixture.nativeElement.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

    expect(probe?.textContent).toBe('Traffic English probe');
    i18n.setLocale('ru', ruCatalog);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe('Проба трафика');
  });
  it('passes normalized persisted refresh to settings opener', async () => {
    const {fixture, openSettings} = await createFixture('eth1', '6000');

    await fixture.componentInstance.ngOnInit();

    (fixture.componentInstance as unknown as {openSettingsDialog: () => void}).openSettingsDialog();

    expect(openSettings).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Widget settings',
      selectedInterface: 'eth1',
      refresh: 5000,
    }));
  });

  it('rounds persisted refresh values to the nearest half second', async () => {
    const {fixture, openSettings} = await createFixture('eth1', '2750');

    await fixture.componentInstance.ngOnInit();

    (fixture.componentInstance as unknown as {openSettingsDialog: () => void}).openSettingsDialog();

    expect(openSettings).toHaveBeenCalledWith(expect.objectContaining({refresh: 3000}));
  });

  it('keeps a fresh widget on the empty interface state', async () => {
    const {fixture} = await createFixture(null, '3000');

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    const select = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-select');

    expect(select.getAttribute('placeholder')).toBe('Select interface…');
  });

  it('calls setTileTitle with the active interface name when provided', async () => {
    const {fixture, setTileTitle} = await createFixture('eth1', '3000');

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(setTileTitle).toHaveBeenCalledWith('WAN');
  });

  it('calls setTileTitle with an empty string when no interface is selected', async () => {
    const {fixture, setTileTitle} = await createFixture(null, '3000');

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(setTileTitle).toHaveBeenCalledWith('');
  });

  it('keeps the internal interface label when setTileTitle is absent', async () => {
    const {fixture} = await createFixture('eth1', '3000', null);

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('.chart-header__label');

    expect(label).not.toBeNull();
    expect(label.textContent).toBe('WAN');
  });

  it('hides the internal interface label when setTileTitle is provided', async () => {
    const {fixture} = await createFixture('eth1', '3000', () => undefined);

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('.chart-header__label');

    expect(label).toBeNull();
  });

  it('renders the shared line chart with normalized properties', async () => {
    const {fixture} = await createFixture('eth1', '3000');

    await fixture.componentInstance.ngOnInit();
    await flushFirstPoll(fixture);

    const chart = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart') as HTMLElement & {
      series?: Array<{label?: string; color?: string}>;
      domain?: {start: number; end: number};
      valueFormatter?: (value: number) => string;
      valueDomain?: {min: number; max: number};
    };

    expect(chart.series?.map((series) => [series.label, series.color])).toEqual([
      ['TX', 'accent'],
      ['RX', 'success'],
    ]);
    expect(chart.domain?.end).toBe(new Date(2026, 0, 1, 12).getTime());
    expect(chart.valueFormatter?.(1500)).toBe('1.5 Kb/s');
    expect(chart.valueDomain?.min).toBe(0);
    expect(chart.valueDomain?.max).toBeGreaterThanOrEqual(5000);
    expect(chart.getAttribute('aria-label')).toBe('Interface traffic for WAN');
  });

  it('advances chart timestamps when newer RRD data arrives', async () => {
    vi.useFakeTimers();

    const rrdResponses = new Subject<[RrdResponse, RrdResponse]>();
    const {fixture} = await createFixture(
      'eth1',
      '3000',
      undefined,
      createTestI18n(enCatalog),
      fakeManager(rrdResponses),
    );

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1);

    rrdResponses.next([{data: [{t: 100, v: 100}]}, {data: [{t: 100, v: 50}]}]);
    fixture.detectChanges();

    const chart = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart') as HTMLElement & {
      domain?: {start: number; end: number};
    };
    const firstEnd = new Date(2026, 0, 1, 12).getTime();

    expect(chart.domain?.end).toBe(firstEnd);

    rrdResponses.next([{data: [{t: 103, v: 200}]}, {data: [{t: 103, v: 75}]}]);
    fixture.detectChanges();

    expect(chart.domain?.end).toBe(firstEnd + 3_000);
  });

  it('localizes the chart aria-label after a locale switch', async () => {
    const i18n = createTestI18n(enCatalog);
    const {fixture} = await createFixture('eth1', '3000', undefined, i18n);

    await fixture.componentInstance.ngOnInit();
    await flushFirstPoll(fixture);

    const chart = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart');

    expect(chart.getAttribute('aria-label')).toBe('Interface traffic for WAN');

    i18n.setLocale('ru', ruCatalog);
    fixture.detectChanges();

    expect(chart.getAttribute('aria-label')).toBe('Трафик интерфейса WAN');
  });

  it('shows a loading state until the first poll returns', async () => {
    const {fixture} = await createFixture('eth1', '3000');

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(queryElement<HTMLElement>(fixture.nativeElement, '.loading').textContent).toBe('Loading traffic data…');
    expect(fixture.nativeElement.querySelector('mndw-line-chart')).toBeNull();
  });

  it('shows the legend as soon as an interface is selected', async () => {
    const {fixture} = await createFixture('eth1', '3000');

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.chart-header__legend')).not.toBeNull();
  });

  it('keeps polling traffic after a transient request error and clears the error on success', async () => {
    vi.useFakeTimers();

    const {manager, rrdCalls} = sequencedManager(
      (call) =>
        call === 1
          ? throwError(() => new Error('temporary'))
          : of(rrdPair(100, 1000, 500)),
    );
    const {fixture} = await createFixture('eth1', '3000', undefined, createTestI18n(enCatalog), manager);

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();

    expect(rrdCalls()).toBe(1);
    expect(queryElement<HTMLElement>(fixture.nativeElement, '.mndw-alert--danger').textContent)
      .toContain('Failed to load traffic data');

    await vi.advanceTimersByTimeAsync(3000);
    fixture.detectChanges();

    expect(rrdCalls()).toBe(2);
    expect(fixture.nativeElement.querySelector('.mndw-alert--danger')).toBeNull();
    expect(queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart')).not.toBeNull();

    const pollingSub = (fixture.componentInstance as unknown as {pollingSub: Subscription | null}).pollingSub;

    expect(pollingSub?.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);

    expect(rrdCalls()).toBe(3);
  });

  it('keeps polling device time after a transient request error and clears the error on success', async () => {
    vi.useFakeTimers();

    const {manager, deviceTimeCalls} = sequencedManager(
      undefined,
      (call) =>
        call === 3
          ? throwError(() => new Error('temporary'))
          : of(clockDate),
    );
    const {fixture} = await createFixture('eth1', '3000', undefined, createTestI18n(enCatalog), manager);

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();

    expect(deviceTimeCalls()).toBe(3);
    expect(queryElement<HTMLElement>(fixture.nativeElement, '.mndw-alert--danger').textContent)
      .toContain('Failed to load device time');

    await vi.advanceTimersByTimeAsync(30000);
    fixture.detectChanges();

    expect(deviceTimeCalls()).toBe(4);
    expect(fixture.nativeElement.querySelector('.mndw-alert--danger')).toBeNull();

    const deviceTimeSub = (fixture.componentInstance as unknown as {deviceTimeSub: Subscription | null}).deviceTimeSub;

    expect(deviceTimeSub?.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(30000);

    expect(deviceTimeCalls()).toBe(5);
  });

  it('loads interfaces when settings storage fails and shows a non-blocking warning', async () => {
    const storage = {
      get: vi.fn(() => Promise.reject(new Error('read failed'))),
      set: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    } as unknown as PluginStorage;

    const {manager, paths} = sequencedManager(() => of(rrdPair(100, 1000, 500)));
    const {fixture} = await createFixture(null, null, undefined, createTestI18n(enCatalog), manager, storage);

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();

    expect(paths).toContain('show.interface');
    expect(fixture.nativeElement.querySelectorAll('mndw-option')).toHaveLength(2);
    expect(queryElement<HTMLElement>(fixture.nativeElement, '[data-testid="storage-warning"]').textContent)
      .toContain('Settings could not be loaded or saved');
    expect(fixture.nativeElement.querySelector('.mndw-alert--danger')).toBeNull();

    (fixture.componentInstance as unknown as {onInterfaceChange: (id: string) => void}).onInterfaceChange('eth1');
    await flushFirstPoll(fixture);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.mndw-alert--danger')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="storage-warning"]')).not.toBeNull();
    expect(queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart')).not.toBeNull();
  });

  it('resets chart data when switching interfaces and ignores the previous interface response', async () => {
    vi.useFakeTimers();

    const {manager, requests} = manualRrdManager();
    const {fixture} = await createFixture('eth1', '3000', undefined, createTestI18n(enCatalog), manager);

    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.interfaceId).toBe('eth1');

    requests[0]?.response.next(rrdPair(100, 1000, 500));
    fixture.detectChanges();

    expect(queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart')).not.toBeNull();

    (fixture.componentInstance as unknown as {onInterfaceChange: (id: string) => void}).onInterfaceChange('eth0');
    fixture.detectChanges();

    expect(queryElement<HTMLElement>(fixture.nativeElement, '.loading').textContent).toBe('Loading traffic data…');
    expect(fixture.nativeElement.querySelector('mndw-line-chart')).toBeNull();

    requests[0]?.response.next(rrdPair(200, 9000, 8000));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mndw-line-chart')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.interfaceId).toBe('eth0');

    requests[1]?.response.error(new Error('temporary'));
    fixture.detectChanges();

    expect(queryElement<HTMLElement>(fixture.nativeElement, '.mndw-alert--danger').textContent)
      .toContain('Failed to load traffic data');

    const chart = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart') as HTMLElement & {
      series?: Array<{data?: unknown[]}>;
    };

    expect(chart.series?.every((series) => (series.data?.length ?? 0) === 0)).toBe(true);
  });
});
