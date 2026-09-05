import '@angular/compiler';
import {ɵresolveComponentResources as resolveComponentResources} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {createTestI18n} from '@mndw/sdk/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MwsNode} from '../../domain/mws/mws.types';
import {type MwsWriteResult, MwsWriteService} from '../../services/mws-write.service';
import {type NodeEditState, NodeSettingsStore} from '../../services/node-settings.store';
import {TRANSLATOR} from '../../tokens';
import enCatalog from '../../../i18n/en.json';
import settingsTemplate from './node-settings.component.html?raw';
import settingsStyles from './node-settings.component.scss?raw';
import {NodeSettingsComponent} from './node-settings.component';

const okResult = (): MwsWriteResult => ({ok: true, steps: []});

const node = (): MwsNode => ({
  id: 'node-1',
  cid: 'cid-1',
  name: 'My Extender',
  model: 'Buddy 6',
  ip: '192.168.1.20',
  mac: '02:7d:4a:91:c3:21',
  isController: false,
  isOnline: true,
  fw: '5.2',
  fwAvailable: null,
  system: null,
  backhaul: null,
  parent: null,
  children: [],
  clients: [],
  dualBand: false,
  persistentSession: false,
  hwId: 'KN-3411',
  ports: [
    {index: 0, label: 'Port 0', appearance: null, link: 'up', speed: '1000', duplex: 'full'},
    {index: 1, label: 'Port 1', appearance: null, link: null, speed: null, duplex: null},
  ],
  fwUpdateAvailable: false,
  fwUpdateSandboxes: [{version: '5.3', name: 'stable'}],
  wirelessBands: ['2.4'],
});

const initialState: NodeEditState = {
  staticIpEnabled: false,
  staticIp: null,
  updateChannel: null,
  portRoles: [
    {port: 0, role: 'primary'},
    {port: 1, role: 'primary'},
  ],
};

describe('NodeSettingsComponent', () => {
  let setName: ReturnType<typeof vi.fn>;
  let setStaticIP: ReturnType<typeof vi.fn>;
  let setUpdateChannel: ReturnType<typeof vi.fn>;
  let setPortRole: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    setName = vi.fn(() => Promise.resolve(okResult()));
    setStaticIP = vi.fn(() => Promise.resolve(okResult()));
    setUpdateChannel = vi.fn(() => Promise.resolve(okResult()));
    setPortRole = vi.fn(() => Promise.resolve(okResult()));
    await resolveComponentResources((url: string) => {
      if (url.endsWith('node-settings.component.html')) {
        return Promise.resolve(settingsTemplate);
      }

      if (url.endsWith('node-settings.component.scss')) {
        return Promise.resolve(settingsStyles);
      }

      throw new Error(`resource URL: ${url}`);
    });
    await TestBed.configureTestingModule({
      imports: [NodeSettingsComponent],
      providers: [
        NodeSettingsStore,
        {provide: MwsWriteService, useValue: {setName, setStaticIP, setUpdateChannel, setPortRole}},
        {provide: TRANSLATOR, useValue: createTestI18n(enCatalog)},
      ],
    }).compileComponents();
  });

  afterEach(() => TestBed.resetTestingModule());

  function render(
    state: NodeEditState = initialState,
    segments: readonly {id: string; label: string}[] = [{id: 'Bridge0', label: 'LAN'}],
  ): ReturnType<typeof TestBed.createComponent<NodeSettingsComponent>> {
    const store = TestBed.inject(NodeSettingsStore);

    store.initialize(node().name, state, segments);

    const fixture = TestBed.createComponent(NodeSettingsComponent);

    fixture.componentRef.setInput('node', node());
    fixture.detectChanges();

    return fixture;
  }

  it('pre-fills name, channel, static IP, port roles, and returned segment IDs', () => {
    const fixture = render({
      staticIpEnabled: true,
      staticIp: '192.168.1.50',
      updateChannel: 'stable',
      portRoles: [
        {port: 0, role: 'disabled'},
        {port: 1, role: {segment: 'Guest42'}},
      ],
    }, [{id: 'Guest42', label: 'Guest network'}]);

    expect((fixture.nativeElement.querySelector('[data-field="name"]') as HTMLElement & {value: string}).value)
      .toBe('My Extender');
    expect((fixture.nativeElement.querySelector('[data-field="static-ip"]') as HTMLElement & {value: string}).value)
      .toBe('192.168.1.50');
    expect((fixture.nativeElement.querySelector('[data-port="0"]') as HTMLElement & {value: string}).value)
      .toBe('disabled');
    expect((fixture.nativeElement.querySelector('[data-port="1"]') as HTMLElement & {value: string}).value)
      .toBe('segment:Guest42');
    expect(fixture.nativeElement.querySelector('[data-port="1"]')?.textContent).toContain('Guest network');
    expect(fixture.nativeElement.querySelector('[data-port="1"]')?.textContent).not.toContain('Bridge0');
  });

  it('uses shared UI controls for settings fields', () => {
    const fixture = render({
      staticIpEnabled: true,
      staticIp: '192.168.1.50',
      updateChannel: null,
      portRoles: initialState.portRoles,
    });

    expect(fixture.nativeElement.querySelector('mndw-input[data-field="name"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mndw-input[data-field="static-ip"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mndw-checkbox[data-field="static-ip-toggle"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('mndw-select')).toHaveLength(3);
    expect(fixture.nativeElement.querySelectorAll('input, select')).toHaveLength(0);
  });

  it('maps Bridge0 to Primary and renders only Disabled plus loaded segments', () => {
    const fixture = render(initialState, [
      {id: 'Bridge0', label: 'Home network'},
      {id: 'Guest', label: 'Guest network'},
    ]);
    const port = fixture.nativeElement.querySelector('[data-port="0"]')?.parentElement;
    const options = [...(port?.querySelectorAll('mndw-option') ?? [])];

    expect(options.map((option) => option.getAttribute('value'))).toEqual(['disabled', 'primary', 'segment:Guest']);
    expect(options[1]?.textContent).toContain('Home network');
  });

  it('validates IPv4 and saves changed fields in parallel', async () => {
    const fixture = render();
    const name = fixture.nativeElement.querySelector('[data-field="name"]') as HTMLElement;
    const channel = fixture.nativeElement.querySelector('[data-field="update-channel"]') as HTMLElement;

    name.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: 'Renamed'}}));
    channel.dispatchEvent(new CustomEvent('mndwchange', {bubbles: true, composed: true, detail: {value: 'stable'}}));
    fixture.detectChanges();
    fixture.componentInstance.saveChanges();
    await Promise.resolve();
    await Promise.resolve();

    expect(setName).toHaveBeenCalledWith('02:7d:4a:91:c3:21', 'Renamed');
    expect(setUpdateChannel).toHaveBeenCalledWith('02:7d:4a:91:c3:21', 'stable');

    const invalidFixture = render();
    const toggle = invalidFixture.nativeElement.querySelector('[data-field="static-ip-toggle"]') as HTMLElement;

    toggle.dispatchEvent(
      new CustomEvent('mndwchange', {
        bubbles: true,
        composed: true,
        detail: {checked: true, indeterminate: false},
      }),
    );
    invalidFixture.detectChanges();

    const staticIp = invalidFixture.nativeElement.querySelector('[data-field="static-ip"]') as HTMLElement;

    staticIp.dispatchEvent(
      new CustomEvent('mndwinput', {
        bubbles: true,
        composed: true,
        detail: {value: '999.999.999.999'},
      }),
    );
    invalidFixture.detectChanges();
    invalidFixture.componentInstance.saveChanges();
    invalidFixture.detectChanges();

    expect(invalidFixture.nativeElement.querySelector('[data-field-error="static-ip"]')?.textContent)
      .toContain('valid IPv4');
  });

  it('keeps a failed field retryable and shows the device error', async () => {
    setName.mockResolvedValueOnce({
      ok: false,
      steps: [{step: 'set-name', ok: false,
        status: [{status: 'error', code: '1', ident: 'Known', message: 'Name rejected'}]}],
    });
    setName.mockResolvedValue(okResult());

    const fixture = render();
    const name = fixture.nativeElement.querySelector('[data-field="name"]') as HTMLElement;

    name.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: 'Rejected'}}));
    fixture.detectChanges();
    fixture.componentInstance.saveChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-field-error="name"]')?.textContent).toContain('Name rejected');

    const retry = fixture.nativeElement.querySelector<HTMLButtonElement>(
      '[data-action="retry-field"][data-field="name"]',
    );

    expect(retry).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-save-success]')).toBeNull();
    retry?.click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(setName).toHaveBeenCalledTimes(2);
    expect(setUpdateChannel).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-save-success]')).not.toBeNull();
  });

  it('starts reconciliation after a save response that fails at device commit', async () => {
    const reconcileRequested = vi.fn();

    setName.mockResolvedValue({
      ok: false,
      steps: [
        {step: 'set-name', ok: true, status: []},
        {step: 'save', ok: false, status: [{status: 'error', code: '1', ident: 'Save', message: 'Commit rejected'}]},
      ],
    });

    const fixture = render();

    fixture.componentInstance.reconcileRequested.subscribe(reconcileRequested);

    const name = fixture.nativeElement.querySelector('[data-field="name"]') as HTMLElement;

    name.dispatchEvent(new CustomEvent('mndwinput', {bubbles: true, composed: true, detail: {value: 'Needs reread'}}));
    fixture.detectChanges();
    fixture.componentInstance.saveChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(reconcileRequested).toHaveBeenCalledOnce();
    expect(TestBed.inject(NodeSettingsStore).reconciliation()).toBe('loading');
    expect(fixture.componentInstance.saveDisabled()).toBe(true);
  });
});
