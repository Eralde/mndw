import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {type ComponentFixture, TestBed} from '@angular/core/testing';
import type {PluginStorage} from '@mndw/sdk';
import type {RciManager, RciQuery} from '@rci-tools/core';
import {of} from 'rxjs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OpenSettingsFn} from '../open-settings-dialog';
import {PLUGIN_STORAGE, RCI_MANAGER} from '../tokens';
import appStyles from './app.component.scss?raw';
import appTemplate from './app.component.html?raw';
import {AppComponent as AppComponentType} from './app.component';

const interfaces = {
  eth0: {id: 'eth0', description: 'LAN', traits: ['Ip']},
  eth1: {id: 'eth1', description: 'WAN', traits: ['Ip']},
};

let fixtures: ComponentFixture<AppComponentType>[] = [];

function fakeManager(): RciManager {
  return {
    queue: (query: RciQuery | RciQuery[]) => {
      const path = Array.isArray(query) ? query[0]?.path : query.path;

      if (path === 'show.interface') {
        return of(interfaces);
      }

      if (path === 'show.clock.date') {
        return of({weekday: 1, day: 1, month: 1, year: 2026, hour: 12, min: 0, sec: 0, msec: 0});
      }

      return of([{data: []}, {data: []}]);
    },
  } as unknown as RciManager;
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

function queryElement<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

async function createFixture(
  savedInterface: string | null,
  savedRefresh: string | null,
  setTileTitle?: ((title: string) => void) | null,
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
      {provide: RCI_MANAGER, useValue: fakeManager()},
      {provide: PLUGIN_STORAGE, useValue: fakeStorage(savedInterface, savedRefresh)},
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
  vi.unstubAllGlobals();
});

describe('AppComponent', () => {
  it('passes normalized persisted refresh to settings opener', async () => {
    const {fixture, openSettings} = await createFixture('eth1', '6000');

    await fixture.componentInstance.ngOnInit();

    (fixture.componentInstance as unknown as {openSettingsDialog: () => void}).openSettingsDialog();

    expect(openSettings).toHaveBeenCalledWith(expect.objectContaining({
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
    fixture.detectChanges();

    const chart = queryElement<HTMLElement>(fixture.nativeElement, 'mndw-line-chart') as HTMLElement & {
      series?: Array<{label?: string; color?: string}>;
      domain?: {start: number; end: number};
    };

    expect(chart.series?.map((series) => [series.label, series.color])).toEqual([
      ['TX', 'accent'],
      ['RX', 'success'],
    ]);
    expect(chart.domain?.end).toBe(new Date(2026, 0, 1, 12).getTime());
    expect(chart.getAttribute('aria-label')).toBe('Interface traffic for WAN');
  });
});
