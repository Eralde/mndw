import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {MWSD_BACKEND} from '../tokens';
import {type ExtraFeaturesAvailability, MwsDataService} from './mws-data.service';
import {MwsWriteService} from './mws-write.service';

describe('MwsWriteService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
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
      'degraded',
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

    availability.set('degraded');
    resolveResponse(new Response(JSON.stringify({ok: true, steps: []}), {status: 200}));

    await expect(call).resolves.toEqual({ok: true, steps: []});
  });
});
