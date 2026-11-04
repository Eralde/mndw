import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient, PluginRciManager} from '@mndw/sdk';
import {of} from 'rxjs';
import {MWSD_BACKEND, RCI_MANAGER} from '../tokens';
import {type ExtraFeaturesAvailability, MwsDataService} from './mws-data.service';
import {MwsWriteService} from './mws-write.service';

describe('MwsWriteService', () => {
  let queue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    queue = vi.fn();
    TestBed.configureTestingModule({providers: [
      {provide: RCI_MANAGER, useValue: {queue} as unknown as PluginRciManager},
    ]});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('calls the declared write route with typed set-power parameters', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          steps: [{step: 'set-power', ok: true, status: []}, {step: 'save', ok: false, status: []}],
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );
    const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

    TestBed.configureTestingModule({providers: [
      MwsWriteService,
      {provide: MWSD_BACKEND, useValue: backend},
      {provide: MwsDataService, useValue: {extraFeaturesAvailability: signal<ExtraFeaturesAvailability>('active')}},
    ]});

    const result = await TestBed.inject(MwsWriteService).setPower('cid-1', 'WifiMaster0', 75, true);

    expect(fetch).toHaveBeenCalledWith('write', {
      body: {
        operation: 'wifi.set-power',
        nodeId: 'cid-1',
        params: {interface: 'WifiMaster0', power: 75, persist: true},
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps[1]?.step).toBe('save');
  });

  it.each(
    [
      'checking',
      'starting',
      'unavailable',
      'limited',
      'blocked',
      'incompatible',
    ] as const,
  )('rejects %s availability before dispatch', async (availability) => {
    const fetch = vi.fn();
    const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

    TestBed.configureTestingModule({providers: [
      MwsWriteService,
      {provide: MWSD_BACKEND, useValue: backend},
      {provide: MwsDataService, useValue: {extraFeaturesAvailability: signal(availability)}},
    ]});

    await expect(TestBed.inject(MwsWriteService).setPower('cid-1', 'WifiMaster0', 75, true))
      .rejects.toThrow('mws-page extra features are unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows a dispatched write to settle after availability changes', async () => {
    const availability = signal<ExtraFeaturesAvailability>('active');
    let resolveResponse = (_response: Response): void => {};
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetch = vi.fn(() => pending);
    const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

    TestBed.configureTestingModule({providers: [
      MwsWriteService,
      {provide: MWSD_BACKEND, useValue: backend},
      {provide: MwsDataService, useValue: {extraFeaturesAvailability: availability}},
    ]});

    const call = TestBed.inject(MwsWriteService).setPower('cid-1', 'WifiMaster0', 75, true);

    availability.set('limited');
    resolveResponse(new Response(JSON.stringify({ok: true, steps: []}), {status: 200}));

    await expect(call).resolves.toEqual({ok: true, steps: []});
  });

  it('sends direct-RCI configuration writes without using the backend', async () => {
    queue.mockReturnValue(of([
      {status: [{status: 'message', code: '1', ident: 'KnownHosts', message: 'updated'}]},
      {status: [{status: 'message', code: '2', ident: 'StartupConfig', message: 'saved'}]},
    ]));

    const fetch = vi.fn();
    const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

    TestBed.configureTestingModule({providers: [
      MwsWriteService,
      {provide: MWSD_BACKEND, useValue: backend},
      {provide: MwsDataService, useValue: {extraFeaturesAvailability: signal<ExtraFeaturesAvailability>('active')}},
    ]});

    const result = await TestBed.inject(MwsWriteService).setName('02:7D:4A:91:C3:21', 'Extender');

    expect(result.ok).toBe(true);
    expect(queue).toHaveBeenCalledWith([
      {path: 'known.host', data: {mac: '02:7d:4a:91:c3:21', name: 'Extender'}},
      {path: 'system.configuration.save'},
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes a direct-RCI device error into a failed write result', async () => {
    queue.mockReturnValue(of([
      {status: [{status: 'error', code: '4', ident: 'KnownHosts', message: 'name rejected'}]},
      {status: [{status: 'message', code: '2', ident: 'StartupConfig', message: 'saved'}]},
    ]));

    const fetch = vi.fn();
    const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

    TestBed.configureTestingModule({providers: [
      MwsWriteService,
      {provide: MWSD_BACKEND, useValue: backend},
      {provide: MwsDataService, useValue: {extraFeaturesAvailability: signal<ExtraFeaturesAvailability>('active')}},
    ]});

    const result = await TestBed.inject(MwsWriteService).setStaticIP('02:7d:4a:91:c3:21', '192.168.1.100');

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.status[0]?.message).toBe('name rejected');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends port and automatic-update settings through direct RCI', async () => {
    queue.mockReturnValue(of([
      {
        mws: {
          member: {
            port: {
              access: {
                status: [{
                  status: 'message',
                  code: '5376052',
                  ident: 'Mws::Controller::Manager',
                  message: 'attached',
                }],
              },
            },
          },
        },
      },
      {
        system: {
          configuration: {
            save: {
              status: [{
                status: 'message',
                code: '8912996',
                ident: 'Core::System::StartupConfig',
                message: 'saving',
              }],
            },
          },
        },
      },
    ]));
    TestBed.configureTestingModule({providers: [
      MwsWriteService,
      {provide: MWSD_BACKEND, useValue: null},
      {provide: MwsDataService, useValue: {extraFeaturesAvailability: signal<ExtraFeaturesAvailability>('active')}},
    ]});

    const service = TestBed.inject(MwsWriteService);

    const portResult = await service.setPortRole('02:7d:4a:91:c3:21', '3', 'primary', {segment: 'Bridge1'});

    expect(portResult.ok).toBe(true);
    expect(queue).toHaveBeenLastCalledWith([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '3', access: {interface: 'Bridge1'}}}},
      {path: 'system.configuration.save'},
    ]);

    await service.setAutoUpdateSchedule(null);
    expect(queue).toHaveBeenLastCalledWith([
      {path: 'components.auto-update', data: {schedule: {no: true}}},
      {path: 'system.configuration.save'},
    ]);
  });
});
