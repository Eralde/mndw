import '@angular/compiler';
import {signal, ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {type TestI18n, createTestI18n} from '@mndw/sdk/testing';
import {Subject, of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeDeviceHosts, normalizeMembers} from '../../api/normalize';
import {buildMap, findNodeById} from '../../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../../domain/mws/mws.types';
import {loadFixture} from '../../fixtures/load';
import {type ExtraFeaturesAvailability, MwsDataService} from '../../services/mws-data.service';
import {MwsWriteService} from '../../services/mws-write.service';
import {MWS_RENAME_API, RCI_MANAGER, TRANSLATOR} from '../../tokens';
import drawerStyles from './node-drawer.component.scss?raw';
import drawerTemplate from './node-drawer.component.html?raw';
import {NodeDrawerComponent} from './node-drawer.component';
import enCatalog from '../../../i18n/en.json';
import ruCatalog from '../../../i18n/ru.json';

const CONTROLLER: ControllerInfo = {
  mac: '02:7d:4a:91:c3:10',
  ip: '192.168.1.1',
  name: 'Router',
  model: 'Hopper (KN-3811)',
  firmware: '5.2 Alpha 1',
  interfaceUptime: 3201,
  isOnline: true,
};

function roots(): MwsNode[] {
  return buildMap(
    normalizeMembers(loadFixture('show-mws-member.json')),
    normalizeDeviceHosts(loadFixture('show-device-list.json')),
    CONTROLLER,
  );
}

function withPower(
  node: MwsNode,
  live: boolean,
  power2g: {value: number | null; available: boolean},
  power5g: {value: number | null; available: boolean} = {value: 50, available: true},
): MwsNode {
  return {...node, persistentSession: live, wifiPower: {power2g, power5g}};
}

function slider(
  fixture: {nativeElement: HTMLElement},
  interfaceName: string,
): HTMLElement & {disabled: boolean; value: number} {
  const element = fixture.nativeElement.querySelector<HTMLElement & {disabled: boolean; value: number}>(
    `mndw-slider[data-radio="${interfaceName}"]`,
  );

  if (element === null) {
    throw new Error(`slider ${interfaceName} not found`);
  }

  return element;
}

describe('NodeDrawerComponent', () => {
  let renameNode: ReturnType<typeof vi.fn>;
  let getAuthUrl: ReturnType<typeof vi.fn>;
  let refreshNow: ReturnType<typeof vi.fn>;
  let setPower: ReturnType<typeof vi.fn>;
  let setName: ReturnType<typeof vi.fn>;
  let settingsQueue: ReturnType<typeof vi.fn>;
  let availability: ReturnType<typeof signal<ExtraFeaturesAvailability>>;
  let testI18n: TestI18n;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    renameNode = vi.fn(() => of(undefined));
    getAuthUrl = vi.fn(() => Promise.resolve('https://example.test/auth'));
    refreshNow = vi.fn();
    setPower = vi.fn(() => Promise.resolve({ok: true, steps: []}));
    setName = vi.fn(() => Promise.resolve({ok: true, steps: []}));
    settingsQueue = vi.fn(() =>
      of([
        {},
        {},
        {Bridge0: {iseg: {}}},
        {Bridge0: {id: 'Bridge0', type: 'Bridge', description: 'Home network'}},
      ])
    );
    availability = signal<ExtraFeaturesAvailability>('active');
    testI18n = createTestI18n(enCatalog);
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-drawer.component.html')) {
        return Promise.resolve(drawerTemplate);
      }

      if (url.endsWith('node-drawer.component.scss')) {
        return Promise.resolve(drawerStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [NodeDrawerComponent],
      providers: [
        {provide: MWS_RENAME_API, useValue: {renameNode, getAuthUrl}},
        {provide: MwsDataService, useValue: {refreshNow, freshnessNow: () =>
          10_000, extraFeaturesAvailability: availability}},
        {provide: MwsWriteService, useValue: {setPower, setName}},
        {
          provide: RCI_MANAGER,
          useValue: {
            queue: settingsQueue,
          },
        },
        {provide: TRANSLATOR, useValue: testI18n},
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders identity, wireless backhaul, and clients for an extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Mesh Extender A');
    expect(text).toContain('Buddy 6 (KN-3411)');
    expect(text).toContain('−35 dBm');
    expect(text).toContain('1.2 Gbit/s');
    expect(text).toContain('11ax');
  });

  it('wraps identity details in detail-pair elements for 2-column layout', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    if (node === null) {
      throw new Error('expected extender fixture node');
    }

    fixture.componentRef.setInput('node', node);
    fixture.detectChanges();

    const dl = fixture.nativeElement.querySelector('dl.identity-details');

    if (dl === null) {
      throw new Error('expected identity details list');
    }

    expect(dl.querySelectorAll('.detail-pair')).toHaveLength(7);
  });

  it('preserves backhaul detail list structure without detail-pair wrappers', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    if (node === null) {
      throw new Error('expected extender fixture node');
    }

    fixture.componentRef.setInput('node', node);
    fixture.detectChanges();

    const backhaulDl = fixture.nativeElement.querySelector('.backhaul dl');

    if (backhaulDl === null) {
      throw new Error('expected backhaul details list');
    }

    expect(backhaulDl.querySelector('.detail-pair')).toBeNull();
    expect(backhaulDl.querySelectorAll('dt').length).toBeGreaterThan(0);
  });

  it('shows a device-panel action only for online extenders', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const extender = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput('node', extender);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-action="open-web-panel"]')).not.toBeNull();

    const popup = {
      closed: false,
      opener: window,
      location: {href: 'about:blank'},
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);

    fixture.nativeElement.querySelector<HTMLElement>('[data-action="open-web-panel"]')?.click();
    await Promise.resolve();
    expect(getAuthUrl).toHaveBeenCalledWith('1a2c405a-fabb-11ee-911a-2559b061cca4');
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect((popup as unknown as {location: {href: string}}).location.href).toBe('https://example.test/auth');
    open.mockRestore();
  });

  it('skips auth-url when the popup is blocked', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    fixture.nativeElement.querySelector<HTMLElement>('[data-action="open-web-panel"]')?.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(getAuthUrl).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Allow pop-ups');
    open.mockRestore();
  });

  it('does not reopen a popup closed while auth-url is loading', async () => {
    let resolveUrl: ((url: string) => void) | undefined;

    getAuthUrl.mockReturnValue(
      new Promise((resolve) => {
        resolveUrl = resolve;
      }),
    );

    const popup = {
      closed: false,
      opener: window,
      location: {href: 'about:blank'},
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    fixture.nativeElement.querySelector<HTMLElement>('[data-action="open-web-panel"]')?.click();
    (popup as unknown as {closed: boolean}).closed = true;
    resolveUrl?.('https://example.test/auth');
    await Promise.resolve();

    expect(open).toHaveBeenCalledOnce();
    open.mockRestore();
  });

  it('renders Status, Settings, and Clients inline for extender nodes', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mndw-tabs')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('mndw-tab')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('mndw-tab#status')?.textContent).toContain('Status');
    expect(fixture.nativeElement.querySelector('mndw-tab#settings')?.textContent).toContain('Settings');
    expect(fixture.nativeElement.querySelector('mndw-tab#clients')?.textContent).toContain('Clients');
    expect(fixture.nativeElement.querySelector('mndw-tab-panel[for="settings"] mws-node-settings')).not.toBeNull();
  });

  it('loads settings with one exact batch before any tab switch', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();

    expect(settingsQueue).toHaveBeenCalledOnce();
    expect(settingsQueue).toHaveBeenCalledWith([
      {path: 'show.sc.ip.dhcp.host'},
      {path: 'show.sc.mws.member'},
      {path: 'show.sc.interface'},
      {path: 'show.interface'},
    ]);
  });

  it('shows settings actions in the drawer footer only after a form change', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-action="save"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-action="cancel"]')).toBeNull();

    const name = fixture.nativeElement.querySelector<HTMLElement>('mws-node-settings [data-field="name"]');

    name?.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: 'Changed extender'},
      }),
    );
    fixture.detectChanges();

    const footer = fixture.nativeElement.querySelector<HTMLElement>('.drawer-footer');

    expect(footer).not.toBeNull();
    expect(footer?.parentElement?.classList.contains('drawer')).toBe(true);
    expect(footer?.querySelectorAll('mndw-button')).toHaveLength(2);
    expect(footer?.querySelector('[data-action="save"]')).not.toBeNull();
    expect(footer?.querySelector('[data-action="cancel"]')).not.toBeNull();
    expect(footer?.querySelector('[data-action="save"]')?.getAttribute('variant')).toBe('primary');
    expect(footer?.querySelector('[data-action="cancel"]')?.getAttribute('variant')).toBe('secondary');
    expect(fixture.nativeElement.querySelector('mws-node-settings [data-action="save"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('mws-node-settings [data-action="cancel"]')).toBeNull();

    footer?.querySelector<HTMLElement>('[data-action="cancel"]')?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.settingsStore.hasChanges()).toBe(false);
    expect(fixture.nativeElement.querySelector('.drawer-footer')).toBeNull();
  });

  it('saves form changes through the drawer footer', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const name = fixture.nativeElement.querySelector<HTMLElement>('mws-node-settings [data-field="name"]');

    name?.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: 'Saved extender'},
      }),
    );
    fixture.detectChanges();
    fixture.nativeElement.querySelector<HTMLElement>('.drawer-footer [data-action="save"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(setName).toHaveBeenCalledWith('02:7d:4a:91:c3:21', 'Saved extender');
    expect(fixture.componentInstance.settingsStore.hasChanges()).toBe(false);
    expect(fixture.nativeElement.querySelector('.drawer-footer')).toBeNull();
  });

  it('does not show settings actions for TX-power changes', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, true, {value: 75, available: true}),
    );
    fixture.detectChanges();
    slider(fixture, 'WifiMaster0').dispatchEvent(
      new CustomEvent('mndwchange', {
        detail: {value: 65},
        bubbles: true,
        composed: true,
      }),
    );
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.drawer-footer')).toBeNull();
  });

  it('keeps controller drawers free of member settings reads', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), CONTROLLER.mac));
    fixture.detectChanges();

    expect(settingsQueue).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelectorAll('mndw-tab')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('mws-node-settings')).toBeNull();
  });

  it('shows retry state after a malformed or status-error settings batch', async () => {
    settingsQueue.mockReturnValueOnce(of([
      {},
      {error: 'member-read-failed', message: 'Member read failed'},
      {},
      {},
    ]));

    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-action="retry-settings"]')).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Member read failed');
  });

  it('ignores a late settings response after switching to another node', async () => {
    const lateResponse = new Subject<unknown>();
    const firstNode = findNodeById(roots(), '02:7d:4a:91:c3:21');
    const secondNode = findNodeById(roots(), '02:7d:4a:91:c3:32');

    settingsQueue
      .mockReturnValueOnce(lateResponse.asObservable())
      .mockReturnValueOnce(of([
        {},
        {},
        {Guest: {iseg: {}}},
        {Guest: {id: 'Guest', type: 'Bridge'}},
      ]));

    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', firstNode);
    fixture.detectChanges();
    fixture.componentRef.setInput('node', secondNode);
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();

    lateResponse.next([{}, {}, {Stale: {iseg: {}}}, {Stale: {id: 'Stale', type: 'Bridge'}}]);
    lateResponse.complete();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.componentInstance.settingsStore.draft()?.name).toBe(secondNode?.name);
    expect(fixture.componentInstance.settingsStore.segments()).toEqual([{id: 'Guest', label: 'Guest'}]);
  });

  it('hides the device-panel action for offline nodes and the controller', () => {
    const offline = buildMap(normalizeMembers([{cid: 'offline', mac: 'aa:00:00:00:00:01'}]), [], CONTROLLER);
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(offline, 'aa:00:00:00:00:01'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-action="open-web-panel"]')).toBeNull();

    fixture.componentRef.setInput('node', findNodeById(roots(), CONTROLLER.mac));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-action="open-web-panel"]')).toBeNull();
  });

  it('places Wi-Fi TX-power controls in the Settings panel', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mndw-tab-panel[for="status"] .wifi-power')).toBeNull();
    expect(fixture.nativeElement.querySelector('mndw-tab-panel[for="settings"] .wifi-power')).not.toBeNull();
  });

  it('renders wired backhaul details for the wired extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:32'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('1 Gbit/s');
    expect(text).toContain('full');
  });

  it('labels the controller and lists its directly-attached clients', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Controller');
    expect(text).toContain('Client A');
  });

  it('renders em dashes for missing values and an offline state for null', () => {
    const offlineOnly = buildMap(normalizeMembers([{cid: 'c1', mac: 'aa:00:00:00:00:01'}]), [], CONTROLLER);
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(offlineOnly, 'aa:00:00:00:00:01'));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('—');

    fixture.componentRef.setInput('node', null);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('no longer reported');
  });

  it('does not render a health block', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.health')).toBeNull();
  });

  it('badges the controller and hides its backhaul section', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), CONTROLLER.mac));
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('.role-badge') as HTMLElement | null;

    expect(badge?.textContent).toContain('Controller');
    expect(fixture.nativeElement.querySelector('.backhaul')).toBeNull();
  });

  it('shows a live-utilization panel with per-metric sparklines only for an active session', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    if (node === null) {
      throw new Error('expected dual-band extender fixture node');
    }

    fixture.componentRef.setInput('node', node);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.utilization')).toBeNull();

    fixture.componentRef.setInput('node', {
      ...node,
      persistentSession: true,
      liveTelemetry: {
        sampledAt: 1_000,
        cpu: {times: [1, 2], values: [10, 20]},
        memory: {times: [1, 2], values: [40, 45]},
        wifi24: {times: [1, 2], values: [28, 31]},
        wifi5: {times: [1, 2], values: [12, 15]},
      },
    });
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.utilization') as HTMLElement | null;

    expect(panel).not.toBeNull();
    // CPU and RAM render as bar sparklines; both Wi-Fi bands as heatmap strips.
    expect(panel?.querySelectorAll('mndw-sparkline')).toHaveLength(2);
    expect(panel?.querySelectorAll('mndw-heat-strip')).toHaveLength(2);
    expect(panel?.textContent).toContain('Wi-Fi 5 GHz');
    expect(panel?.textContent).toContain('31%');

    const sparkline = panel?.querySelector<HTMLElement & {points: readonly {time?: number; value: number}[]}>(
      'mndw-sparkline',
    );
    const heatStrip = panel?.querySelector<HTMLElement & {points: readonly {time?: number; value: number}[]}>(
      'mndw-heat-strip',
    );

    expect(sparkline?.points).toEqual([{time: 1, value: 10}, {time: 2, value: 20}]);
    expect(heatStrip?.points).toEqual([{time: 1, value: 28}, {time: 2, value: 31}]);
    expect(sparkline?.getAttribute('value-label')).toBe('CPU');
    expect(sparkline?.getAttribute('aria-label')).toBe('CPU');
    expect(heatStrip?.getAttribute('value-label')).toBe('Wi-Fi 2.4 GHz');
    expect(heatStrip?.getAttribute('aria-label')).toBe('Wi-Fi 2.4 GHz');
  });

  it('shows the utilization panel for the controller from its direct-RCI telemetry', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const controller = findNodeById(roots(), CONTROLLER.mac);

    if (controller === null) {
      throw new Error('expected controller fixture node');
    }

    fixture.componentRef.setInput('node', {
      ...controller,
      system: {cpuload: 12, memoryUsed: 500, memoryTotal: 1000, uptime: 3201},
      liveTelemetry: {
        sampledAt: 1_000,
        cpu: {times: [1, 2], values: [10, 14]},
        memory: {times: [1, 2], values: [40, 50]},
        wifi24: {times: [1, 2], values: [28, 31]},
        wifi5: {times: [1, 2], values: [12, 15]},
      },
    });
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.utilization') as HTMLElement | null;

    expect(panel).not.toBeNull();
    expect(panel?.querySelectorAll('mndw-sparkline')).toHaveLength(2);
    // Controller is dualBand:false but the 5 GHz strip still shows because it has data.
    expect(panel?.querySelectorAll('mndw-heat-strip')).toHaveLength(2);
    expect(panel?.textContent).toContain('12%');
  });

  it('renders a backhaul section for an extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:21'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.backhaul')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.role-badge')).toBeNull();
  });

  it('explains each disabled TX-power reason through the field hint', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    if (node === null) {
      throw new Error('expected extender fixture node');
    }

    fixture.componentRef.setInput('node', withPower(node, false, {value: 75, available: true}));
    fixture.detectChanges();
    expect((slider(fixture, 'WifiMaster0').parentElement as HTMLElement & {hint: string}).hint)
      .toBe('Remote control is disconnected.');

    fixture.componentRef.setInput('node', withPower(node, true, {value: 75, available: false}));
    fixture.detectChanges();
    expect((slider(fixture, 'WifiMaster0').parentElement as HTMLElement & {hint: string}).hint)
      .toBe('TX power is unavailable.');

    setPower.mockReturnValue(new Promise(() => undefined));
    fixture.componentRef.setInput('node', withPower(node, true, {value: 75, available: true}));
    fixture.detectChanges();
    slider(fixture, 'WifiMaster0').dispatchEvent(new CustomEvent('mndwchange', {detail: {value: 65}, bubbles: true}));
    fixture.detectChanges();

    expect((slider(fixture, 'WifiMaster0').parentElement as HTMLElement & {hint: string}).hint)
      .toBe('TX power update is pending.');
  });

  it('uses extra-features hint and disables live controls before node-specific reasons', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput('node', node === null ? null : withPower(node, true, {value: 75, available: true}));
    fixture.detectChanges();
    availability.set('limited');
    fixture.detectChanges();

    expect(slider(fixture, 'WifiMaster0').disabled).toBe(true);
    expect((slider(fixture, 'WifiMaster0').parentElement as HTMLElement & {hint: string}).hint)
      .toBe('Remote controls require extra features.');
  });

  it('does not dispatch a power change after immediate availability changes', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput('node', node === null ? null : withPower(node, true, {value: 75, available: true}));
    fixture.detectChanges();
    availability.set('unavailable');
    slider(fixture, 'WifiMaster0').dispatchEvent(new CustomEvent('mndwchange', {detail: {value: 65}, bubbles: true}));

    expect(setPower).not.toHaveBeenCalled();
  });

  it('submits a trimmed controller name and updates the title without mutating the node', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:10');
    const setTitle = vi.fn();
    const renamed = vi.fn();

    fixture.componentRef.setInput('node', node);
    fixture.componentRef.setInput('setTitle', setTitle);
    fixture.componentInstance.renamed.subscribe(renamed);
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = '  Renamed Router  ';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
    fixture.detectChanges();

    expect(renameNode).toHaveBeenCalledWith('02:7d:4a:91:c3:10', true, 'Renamed Router');
    expect(refreshNow).toHaveBeenCalledOnce();
    expect(setTitle).toHaveBeenCalledWith('Renamed Router');
    expect(renamed).toHaveBeenCalledWith('Renamed Router');
    expect(node?.name).toBe('Router');
  });

  it('uses the extender rename path through the injected port', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput('node', node);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Renamed Extender';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect(setName).toHaveBeenCalledWith('02:7d:4a:91:c3:21', 'Renamed Extender');
  });

  it('shows local validation errors without calling the API', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = '   ';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect(renameNode).not.toHaveBeenCalled();
    expect(refreshNow).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Name cannot be empty.');
    expect(fixture.nativeElement.querySelector('mndw-input')).not.toBeNull();
  });

  it('translates local validation errors after switching locale', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = '   ';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Name cannot be empty.');

    testI18n.setLocale('ru', ruCatalog);
    fixture.changeDetectorRef.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Имя не может быть пустым.');
  });

  it('cancels on Escape and keeps Save disabled while a write is pending', () => {
    const pending = new Subject<void>();

    renameNode.mockReturnValue(pending);

    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Pending name';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, composed: true}));
    fixture.detectChanges();

    expect(
      (fixture.nativeElement.querySelector<HTMLElement & {disabled: boolean}>('[data-action="save-name"]'))?.disabled,
    ).toBe(true);
    expect((fixture.nativeElement.querySelector<HTMLElement & {disabled: boolean}>('mndw-input'))?.disabled).toBe(true);

    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mndw-input')).not.toBeNull();

    pending.next();
    pending.complete();
  });

  it('keeps entered text and renders a device error after a failed write', () => {
    renameNode.mockReturnValue(throwError(() => new Error('Name rejected by device')));

    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), '02:7d:4a:91:c3:10'));
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="edit-name"]')?.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLElement & {value: string}>('mndw-input');

    input.value = 'Rejected name';
    input.dispatchEvent(new CustomEvent('mndwinput', {detail: {value: input.value}, bubbles: true, composed: true}));
    fixture.nativeElement.querySelector<HTMLElement>('[data-action="save-name"]')?.click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Name rejected by device');
    expect(fixture.nativeElement.querySelector('mndw-input')).not.toBeNull();
    expect((fixture.nativeElement.querySelector('mndw-input') as HTMLElement & {value: string}).value).toBe(
      'Rejected name',
    );
  });

  it('renders one slider for a single-band extender and two for a dual-band extender', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const singleBand = findNodeById(roots(), '02:7d:4a:91:c3:32');
    const dualBand = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      singleBand === null ? null : withPower(singleBand, true, {value: 75, available: true}),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('mndw-slider')).toHaveLength(1);
    expect(slider(fixture, 'WifiMaster0').value).toBe(75);

    fixture.componentRef.setInput(
      'node',
      dualBand === null ? null : withPower(dualBand, true, {value: 75, available: true}),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('mndw-slider')).toHaveLength(2);
    expect(slider(fixture, 'WifiMaster1').value).toBe(50);
  });

  it('does not render TX-power sliders for the controller', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);

    fixture.componentRef.setInput('node', findNodeById(roots(), CONTROLLER.mac));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mndw-slider')).toHaveLength(0);
  });

  it('renders missing power as enabled 100 and failed reads as disabled Unavailable', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, true, {value: 100, available: true}),
    );
    fixture.detectChanges();
    expect(slider(fixture, 'WifiMaster0').value).toBe(100);
    expect(slider(fixture, 'WifiMaster0').disabled).toBe(false);

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, true, {value: 75, available: false}),
    );
    fixture.detectChanges();
    expect(slider(fixture, 'WifiMaster0').value).toBe(75);
    expect(slider(fixture, 'WifiMaster0').disabled).toBe(true);
    expect(slider(fixture, 'WifiMaster0').getAttribute('value-text')).toBe('Unavailable');
  });

  it('disables live controls when persistent session is not live', () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, false, {value: 75, available: true}),
    );
    fixture.detectChanges();

    expect(slider(fixture, 'WifiMaster0').disabled).toBe(true);
  });

  it('sends a persisted write on mndwchange', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, true, {value: 75, available: true}),
    );
    fixture.detectChanges();
    slider(fixture, 'WifiMaster0').dispatchEvent(new CustomEvent('mndwchange', {detail: {value: 65}, bubbles: true}));
    fixture.detectChanges();
    await Promise.resolve();

    expect(setPower).toHaveBeenCalledWith('1a2c405a-fabb-11ee-911a-2559b061cca4', 'WifiMaster0', 65, true);
  });

  it('disables only changed slider while its write is pending', () => {
    let resolveWrite: ((result: {ok: boolean; steps: never[]}) => void) | undefined;

    setPower.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );

    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, true, {value: 75, available: true}),
    );
    fixture.detectChanges();
    slider(fixture, 'WifiMaster0').dispatchEvent(new CustomEvent('mndwchange', {detail: {value: 65}, bubbles: true}));
    fixture.detectChanges();

    expect(slider(fixture, 'WifiMaster0').disabled).toBe(true);
    expect(slider(fixture, 'WifiMaster1').disabled).toBe(false);
    resolveWrite?.({ok: true, steps: []});
  });

  it('keeps optimistic power across stale input and reconciles on a later available poll', async () => {
    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    if (node === null) {
      throw new Error('dual-band fixture node missing');
    }

    const initial = withPower(node, true, {value: 75, available: true});

    fixture.componentRef.setInput('node', initial);
    fixture.detectChanges();
    slider(fixture, 'WifiMaster0').dispatchEvent(new CustomEvent('mndwchange', {detail: {value: 65}, bubbles: true}));
    await Promise.resolve();
    fixture.detectChanges();

    fixture.componentRef.setInput('node', initial);
    fixture.detectChanges();
    expect(slider(fixture, 'WifiMaster0').value).toBe(65);

    fixture.componentRef.setInput('node', withPower(node, true, {value: 65, available: true}));
    fixture.detectChanges();
    expect(slider(fixture, 'WifiMaster0').value).toBe(65);

    fixture.componentRef.setInput('node', withPower(node, true, {value: 70, available: true}));
    fixture.detectChanges();
    expect(slider(fixture, 'WifiMaster0').value).toBe(70);
  });

  it('shows device error and restores raw power after a failed write', async () => {
    setPower.mockResolvedValue({ok: false,
      steps: [{step: 'set-power', ok: false,
        status: [{status: 'error', code: '1', ident: 'wifi', message: 'rejected'}]}]});

    const fixture = TestBed.createComponent(NodeDrawerComponent);
    const node = findNodeById(roots(), '02:7d:4a:91:c3:21');

    fixture.componentRef.setInput(
      'node',
      node === null ? null : withPower(node, true, {value: 75, available: true}),
    );
    fixture.detectChanges();
    slider(fixture, 'WifiMaster0').dispatchEvent(new CustomEvent('mndwchange', {detail: {value: 65}, bubbles: true}));
    await Promise.resolve();
    fixture.detectChanges();

    expect(slider(fixture, 'WifiMaster0').value).toBe(75);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('rejected');
  });
});
