import type {MndwEvent, PluginEventFacade} from '@mndw/sdk';
import {Subject} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import type {EventStreamService} from './event-stream.service.js';
import {createTelemetryGatheringService} from './telemetry-gathering.service.js';

function createHarness(getTelemetry = vi.fn<() => Promise<{enabled: boolean}>>().mockResolvedValue({enabled: false})) {
  const events = new Subject<MndwEvent>();
  const resync = new Subject<void>();
  const facade: PluginEventFacade = {
    select$: vi.fn(() => events.asObservable()),
    resync$: resync.asObservable(),
  };
  const createFacade = vi.fn<EventStreamService['createFacade']>(() => facade);
  const disposeFacade = vi.fn<EventStreamService['disposeFacade']>();
  const eventStream: EventStreamService = {createFacade, disposeFacade};
  const service = createTelemetryGatheringService({getTelemetry, eventStream});

  return {service, getTelemetry, events, resync, createFacade, disposeFacade};
}

function gatheringEvent(enabled: boolean): MndwEvent {
  return {
    id: '01J5KZ00000000000000000000',
    ts: 1725552000123,
    topic: 'telemetry.gathering_changed',
    source: 'internal',
    payload: {enabled},
  };
}

describe('telemetry gathering service', () => {
  it('fetches on first subscription and keeps state unknown until the GET resolves', async () => {
    let resolveGet: ((value: {enabled: boolean}) => void) | undefined;
    const getTelemetry = vi.fn(() => new Promise<{enabled: boolean}>((resolve) => resolveGet = resolve));
    const {service} = createHarness(getTelemetry);
    const listener = vi.fn();

    service.subscribe(listener);

    expect(getTelemetry).toHaveBeenCalledTimes(1);
    expect(service.get()).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    resolveGet?.({enabled: true});
    await vi.waitFor(() => expect(service.get()).toEqual({enabled: true}));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('updates every listener when the daemon reports a setting change', async () => {
    const {service, getTelemetry, events} = createHarness(vi.fn().mockResolvedValue({enabled: true}));
    const first = vi.fn();
    const second = vi.fn();

    service.subscribe(first);
    service.subscribe(second);
    await vi.waitFor(() => expect(service.get()).toEqual({enabled: true}));
    first.mockClear();
    second.mockClear();

    events.next(gatheringEvent(false));

    expect(service.get()).toEqual({enabled: false});
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(getTelemetry).toHaveBeenCalledTimes(1);
  });

  it('refetches state after an event-stream resync', async () => {
    const getTelemetry = vi.fn()
      .mockResolvedValueOnce({enabled: false})
      .mockResolvedValueOnce({enabled: true});
    const {service, resync} = createHarness(getTelemetry);
    const listener = vi.fn();

    service.subscribe(listener);
    await vi.waitFor(() => expect(service.get()).toEqual({enabled: false}));
    listener.mockClear();

    resync.next();

    await vi.waitFor(() => expect(service.get()).toEqual({enabled: true}));
    expect(getTelemetry).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves failed initial reads unknown and does not notify listeners', async () => {
    const {service, getTelemetry} = createHarness(vi.fn().mockRejectedValue(new Error('offline')));
    const listener = vi.fn();

    service.subscribe(listener);
    await vi.waitFor(() => expect(getTelemetry).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(service.get()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the host event facade only while listeners exist', () => {
    const {service, createFacade, disposeFacade} = createHarness(vi.fn().mockResolvedValue({enabled: false}));
    const first = service.subscribe(() => {});
    const second = service.subscribe(() => {});

    expect(createFacade).toHaveBeenCalledTimes(1);
    first();
    expect(disposeFacade).not.toHaveBeenCalled();
    second();

    expect(disposeFacade).toHaveBeenCalledTimes(1);
  });

  it('reports a local setting change immediately', () => {
    const {service} = createHarness();
    const listener = vi.fn();

    service.subscribe(listener);
    listener.mockClear();
    service.report(false);

    expect(service.get()).toEqual({enabled: false});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
