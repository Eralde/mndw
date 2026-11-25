import {readFileSync} from 'node:fs';
import {
  BackendDisabled,
  BackendError,
  BackendNotApproved,
  BackendStarting,
  BackendUnavailable,
  BackendUnknownId,
} from '@mndw/sdk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {AcceptedOperation, Operation, Snapshot} from '../model/api';
import {PageController} from './page-controller';
import {SmartApiError, type SmartClientApi} from './smart-client';
import {type WakeConsentStorage, wakeConsentKey} from './wake-consent';

const snapshot = (): Snapshot => {
  return JSON.parse(readFileSync('backend/testdata/wire/snapshot.golden.json', 'utf8')) as Snapshot;
};

const discoverySnapshot = (): Snapshot => {
  const value = snapshot();

  value.diagnostics.reasons = ['discovery-not-run'];

  return value;
};

const memoryStorage = (): WakeConsentStorage & {values: Map<string, string>} => {
  const values = new Map<string, string>();

  return {
    values,
    keys: vi.fn(() => {
      return Promise.resolve([...values.keys()]);
    }),
    set: vi.fn((key: string, value: string) => {
      values.set(key, value);

      return Promise.resolve();
    }),
  };
};

const runningOperation = {
  schemaVersion: 1 as const,
  id: 'operation-1',
  kind: 'discover' as const,
  deviceId: null,
  status: 'running' as const,
  createdAt: '2026-11-24T10:00:00Z',
  completedAt: null,
  result: null,
  error: null,
};

interface FakeClient {
  snapshot: ReturnType<typeof vi.fn<SmartClientApi['snapshot']>>;
  discover: ReturnType<typeof vi.fn<SmartClientApi['discover']>>;
  refresh: ReturnType<typeof vi.fn<SmartClientApi['refresh']>>;
  operation: ReturnType<typeof vi.fn<SmartClientApi['operation']>>;
  setDeviceType: ReturnType<typeof vi.fn<SmartClientApi['setDeviceType']>>;
}

const fakeClient = (overrides: Partial<FakeClient> = {}): FakeClient => {
  return {
    snapshot: vi.fn<SmartClientApi['snapshot']>().mockResolvedValue(snapshot()),
    discover: vi.fn<SmartClientApi['discover']>().mockResolvedValue({schemaVersion: 1, operationId: 'operation-1'}),
    refresh: vi.fn<SmartClientApi['refresh']>().mockResolvedValue({schemaVersion: 1, operationId: 'operation-1'}),
    operation: vi.fn<SmartClientApi['operation']>().mockResolvedValue(runningOperation),
    setDeviceType: vi.fn<SmartClientApi['setDeviceType']>().mockResolvedValue({
      schemaVersion: 1,
      deviceId: 'device-1',
      deviceType: 'sat',
      deviceTypeSource: 'user',
    }),
    ...overrides,
  };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const startAndFlush = async (controller: PageController): Promise<void> => {
  controller.start();
  await flush();
};

describe('PageController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('late response cannot change selection', async () => {
    let resolveOldSnapshot: ((value: Snapshot) => void) | undefined;
    let resolveCurrentSnapshot: ((value: Snapshot) => void) | undefined;
    const client = fakeClient({
      snapshot: vi.fn()
        .mockImplementationOnce(() =>
          new Promise<Snapshot>((resolve) => {
            resolveOldSnapshot = resolve;
          })
        )
        .mockImplementationOnce(() =>
          new Promise<Snapshot>((resolve) => {
            resolveCurrentSnapshot = resolve;
          })
        )
        .mockResolvedValue(snapshot()),
    });
    const controller = new PageController(client);

    controller.start();
    await vi.waitFor(() => {
      expect(client.snapshot).toHaveBeenCalledTimes(1);
    });
    controller.selectDevice('new-selection');

    const staleSnapshot = {...snapshot(), serverNow: '2026-01-01T00:00:00Z'};
    const afterSelection = controller.getState();
    const timersAfterSelection = vi.getTimerCount();

    resolveOldSnapshot?.(staleSnapshot);
    await vi.waitFor(() => {
      expect(client.snapshot).toHaveBeenCalledTimes(2);
    });
    await flush();

    expect(controller.getState()).toBe(afterSelection);
    expect(vi.getTimerCount()).toBe(timersAfterSelection);
    resolveCurrentSnapshot?.(snapshot());
    await flush();
    expect(controller.getState().selectedDeviceId).toBe('new-selection');
    expect(controller.getState().snapshot?.serverNow).not.toBe(staleSnapshot.serverNow);
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
  });

  it.each([
    ['one discovered device', 1, 'dev-a'],
    ['multiple discovered devices', 2, null],
  ])('auto-selects only when snapshot has %s', async (_name, deviceCount, expectedSelection) => {
    const value = snapshot();
    const first = value.devices[0];

    if (first === undefined) { throw new Error('fixture device is missing'); }

    const devices = [first];

    if (deviceCount === 2) {
      const second = structuredClone(first);

      second.deviceId = 'dev-b';
      second.path = '/dev/sdb';
      devices.push(second);
    }

    value.devices = devices;

    const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(value)}));

    await startAndFlush(controller);

    expect(controller.getState().selectedDeviceId).toBe(expectedSelection);
    controller.stop();
  });

  it('backend restart recovers when an operation disappears', async () => {
    const client = fakeClient({
      operation: vi.fn()
        .mockResolvedValueOnce(runningOperation)
        .mockRejectedValueOnce(new SmartApiError(404, 'unknown-operation')),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await controller.discover();
    expect(client.operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(client.operation).toHaveBeenCalledTimes(2);
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(controller.getState().operation).toBeNull();
    controller.stop();
  });

  it('disconnected refresh requires discovery', async () => {
    const client = fakeClient({refresh: vi.fn().mockRejectedValue(new SmartApiError(409, 'disconnected'))});
    const controller = new PageController(client);

    controller.start();
    controller.selectDevice('device-1');
    await flush();
    await controller.refresh(true);

    expect(controller.getState().notice).toMatchObject({kind: 'disconnected', requiredAction: 'discover'});
    expect(client.refresh).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it.each([
    ['unavailable', new BackendUnavailable('snapshot')],
    ['starting', new BackendStarting('snapshot', null)],
  ])('stores recovery in PageState after %s and clears it on the next read', async (_name, error) => {
    const client = fakeClient({
      snapshot: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(snapshot()),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    expect(controller.getState().notice).toMatchObject({kind: 'request-error'});

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(controller.getState()).toMatchObject({
      backendAvailability: 'available',
      notice: {kind: 'backend-recovered'},
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(controller.getState().notice).toBeNull();
    controller.stop();
  });

  it('keeps recovery notice until the next successful operation read', async () => {
    let resolveOperation: ((value: Operation) => void) | undefined;
    const client = fakeClient({
      snapshot: vi.fn()
        .mockRejectedValueOnce(new BackendUnavailable('snapshot'))
        .mockResolvedValue(snapshot()),
      operation: vi.fn().mockImplementation(() => {
        return new Promise<Operation>((resolve) => {
          resolveOperation = resolve;
        });
      }),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(controller.getState().notice).toMatchObject({kind: 'backend-recovered'});

    const action = controller.discover();

    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(client.operation).toHaveBeenCalledTimes(1);
    expect(controller.getState().notice).toMatchObject({kind: 'backend-recovered'});

    resolveOperation?.(runningOperation);
    await action;
    await flush();
    expect(controller.getState().notice).toBeNull();
    controller.stop();
  });

  it.each([
    ['unknown-id', new BackendUnknownId('snapshot'), 'unknown-id'],
    ['not-approved', new BackendNotApproved('snapshot'), 'not-approved'],
    ['disabled', new BackendDisabled('snapshot'), 'disabled'],
    [
      'non-retryable backend error',
      new BackendError('incompatible', 'BACKEND_MAINTENANCE', 'snapshot', {retryable: false}),
      'incompatible',
    ],
  ])('%s remains a distinct terminal backend state', async (_name, error, expected) => {
    const client = fakeClient({snapshot: vi.fn().mockRejectedValue(error)});
    const controller = new PageController(client);

    await startAndFlush(controller);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(controller.getState().backendAvailability).toBe(expected);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it('retries temporary GET errors with bounded exponential backoff', async () => {
    let attempts = 0;
    const client = fakeClient({
      snapshot: vi.fn(() => {
        attempts += 1;

        if (attempts <= 6 || attempts === 8) {
          return Promise.reject(
            attempts === 1 ? new BackendStarting('snapshot', null) : new BackendUnavailable('snapshot'),
          );
        }

        return Promise.resolve(snapshot());
      }),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);

    const delays = [1000, 2000, 4000, 8000, 30_000] as const;
    const countsBefore = [1, 2, 3, 4, 5] as const;
    const countsAfter = [2, 3, 4, 5, 6] as const;

    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(client.snapshot).toHaveBeenCalledTimes(countsBefore[index]);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(client.snapshot).toHaveBeenCalledTimes(countsAfter[index]);
    }

    expect(attempts).toBe(6);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(client.snapshot).toHaveBeenCalledTimes(7);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(client.snapshot).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(999);
    expect(client.snapshot).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(client.snapshot).toHaveBeenCalledTimes(9);
    controller.stop();
  });

  it('keeps operation backoff when a cache read succeeds', async () => {
    let operationCalls = 0;
    const client = fakeClient({
      operation: vi.fn(() => {
        operationCalls += 1;

        if (operationCalls <= 5) {
          return Promise.reject(new BackendUnavailable('operation'));
        }

        return Promise.resolve(runningOperation);
      }),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await controller.discover();
    expect(client.operation).toHaveBeenCalledTimes(1);

    for (const delay of [1000, 2000, 4000, 8000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
    }

    expect(client.operation).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(client.operation).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(client.operation).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(client.operation).toHaveBeenCalledTimes(6);
    controller.stop();
  });

  it('keeps cache backoff when an operation read succeeds', async () => {
    const client = fakeClient({
      snapshot: vi.fn()
        .mockRejectedValueOnce(new TypeError('network unavailable'))
        .mockRejectedValueOnce(new SyntaxError('invalid cache response'))
        .mockResolvedValue(snapshot()),
      operation: vi.fn().mockRejectedValueOnce(new BackendUnavailable('operation'))
        .mockResolvedValue(runningOperation),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await controller.discover();
    expect(client.operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    expect(client.operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect([client.snapshot.mock.calls.length, client.operation.mock.calls.length]).toEqual([2, 2]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(client.snapshot).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('clears a pending cache poll on a terminal operation error', async () => {
    const client = fakeClient({operation: vi.fn().mockRejectedValue(new BackendDisabled('operation'))});
    const controller = new PageController(client);

    await startAndFlush(controller);
    expect(vi.getTimerCount()).toBe(1);
    await controller.discover();

    expect(controller.getState().backendAvailability).toBe('disabled');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('keeps operation polling paused until a replacement snapshot succeeds', async () => {
    const client = fakeClient({
      snapshot: vi.fn()
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce(snapshot())
        .mockRejectedValueOnce(new TypeError('network unavailable'))
        .mockResolvedValue(snapshot()),
      operation: vi.fn().mockRejectedValueOnce(new BackendUnavailable('operation')),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await controller.discover();
    expect([client.operation.mock.calls.length, vi.getTimerCount()]).toEqual([1, 1]);

    const initialSnapshot = controller.getState().snapshot;
    let changedSelection = false;

    controller.subscribe((state) => {
      if (!changedSelection && state.selectedDeviceId === 'device-1' && state.snapshot !== initialSnapshot) {
        changedSelection = true;
        controller.selectDevice('device-2');
      }
    });
    controller.selectDevice('device-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toMatchObject({selectedDeviceId: 'device-2', backendAvailability: 'unavailable'});
    await vi.advanceTimersByTimeAsync(999);
    expect([client.snapshot.mock.calls.length, client.operation.mock.calls.length]).toEqual([3, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect([client.snapshot.mock.calls.length, client.operation.mock.calls.length]).toEqual([4, 2]);
    controller.stop();
  });

  it.each([
    ['TypeError', new TypeError('network unavailable')],
    ['SyntaxError', new SyntaxError('invalid response')],
    ['decoder error', new Error('invalid snapshot')],
    ['plugin HTTP error', new SmartApiError(404, 'route-not-found')],
  ])('shows temporary unavailable state after a first GET %s', async (_name, error) => {
    const client = fakeClient({snapshot: vi.fn().mockRejectedValueOnce(error)
      .mockResolvedValue(snapshot())});
    const controller = new PageController(client);

    await startAndFlush(controller);

    expect(controller.getState().backendAvailability).toBe('unavailable');
    expect(controller.getState().notice).toMatchObject({kind: 'request-error'});
    expect(controller.getState().snapshot).toBeNull();
    expect(client.snapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(controller.getState().backendAvailability).toBe('available');
    expect(controller.getState().notice).toMatchObject({kind: 'backend-recovered'});

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(controller.getState().notice).toBeNull();
    controller.stop();
  });

  it('retains cached snapshot and selection through a failed cache read', async () => {
    const cached = snapshot();
    const client = fakeClient({
      snapshot: vi.fn()
        .mockResolvedValueOnce(cached)
        .mockResolvedValueOnce(cached)
        .mockRejectedValueOnce(new SyntaxError())
        .mockResolvedValue(cached),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    controller.selectDevice('device-1');
    await flush();

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(controller.getState().snapshot).toBe(cached);
    expect(controller.getState().selectedDeviceId).toBe('device-1');
    expect(controller.getState().backendAvailability).toBe('unavailable');
    expect(controller.getState().notice).toMatchObject({kind: 'request-error'});

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(controller.getState().snapshot).toBe(cached);
    expect(controller.getState().backendAvailability).toBe('available');
    expect(controller.getState().notice).toMatchObject({kind: 'backend-recovered'});

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(controller.getState().notice).toBeNull();
    controller.stop();
  });

  it.each(['hide', 'stop'])('ignores a late operation response after %s', async (lifecycle) => {
    let resolveOperation: ((value: Operation) => void) | undefined;
    const client = fakeClient({
      operation: vi.fn().mockImplementation(() => {
        return new Promise<Operation>((resolve) => {
          resolveOperation = resolve;
        });
      }),
    });
    const controller = new PageController(client);
    const updates: string[] = [];

    controller.subscribe((state) => {
      updates.push(state.operation?.status ?? 'none');
    });
    await startAndFlush(controller);

    const action = controller.discover();

    await vi.waitFor(() => {
      expect(client.operation).toHaveBeenCalledTimes(1);
    });

    const updateCount = updates.length;
    const previousState = controller.getState();

    if (lifecycle === 'hide') {
      controller.setVisible(false);
    } else {
      controller.stop();
    }

    resolveOperation?.({...runningOperation, status: 'succeeded'});
    await action;
    await flush();
    expect(controller.getState()).toBe(previousState);
    expect(updates).toHaveLength(updateCount);
    expect(vi.getTimerCount()).toBe(0);

    if (lifecycle === 'stop') {
      controller.selectDevice('device-1');
      controller.setVisible(false);
      await controller.discover();
      await controller.refresh(false);
      await controller.setDeviceType('sat');

      expect(controller.getState()).toBe(previousState);
      expect(updates).toHaveLength(updateCount);
      expect(client.refresh).not.toHaveBeenCalled();
      expect(client.setDeviceType).not.toHaveBeenCalled();
      expect(client.snapshot).toHaveBeenCalledTimes(1);
      controller.setVisible(true);
      await startAndFlush(controller);
      expect(client.snapshot).toHaveBeenCalledTimes(2);
      controller.stop();
    }
  });

  it('isolates listeners and does not register a listener whose initial call throws', async () => {
    const scheduled: (() => void)[] = [];

    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      scheduled.push(callback);
    });

    const controller = new PageController(fakeClient());
    const initialFailure = vi.fn(() => {
      throw new Error('initial listener failed');
    });
    let failingCalls = 0;
    const failing = vi.fn(() => {
      failingCalls += 1;

      if (failingCalls > 1) {
        throw new Error('listener failed');
      }
    });
    const healthy = vi.fn();

    expect(() => controller.subscribe(initialFailure)).toThrow('initial listener failed');
    controller.subscribe(failing);
    controller.subscribe(healthy);
    await startAndFlush(controller);

    expect(healthy).toHaveBeenCalledTimes(2);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(initialFailure).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]?.()).toThrow('listener failed');
    controller.stop();
  });

  it('discovery action itself authorizes scan and sends wake acknowledgement', async () => {
    const client = fakeClient();
    const controller = new PageController(client);

    await startAndFlush(controller);
    expect(await controller.discover()).toBe('accepted');

    expect(client.discover).toHaveBeenCalledExactlyOnceWith(true, expect.any(AbortSignal));
    expect(client.refresh).not.toHaveBeenCalled();
    controller.stop();
  });

  it('starts discovery automatically once per mount when discovery never ran', async () => {
    const client = fakeClient({
      snapshot: vi.fn().mockResolvedValue(discoverySnapshot()),
      operation: vi.fn().mockRejectedValue(new SmartApiError(404, 'unknown-operation')),
    });
    const onDiscoverAccepted = vi.fn();
    const controller = new PageController(client, {onDiscoverAccepted});

    await startAndFlush(controller);
    await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onDiscoverAccepted).toHaveBeenCalledTimes(1));

    expect(client.discover).toHaveBeenCalledExactlyOnceWith(true, expect.any(AbortSignal));

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(client.discover).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('does not start automatic discovery without an available utility', async () => {
    const value = discoverySnapshot();

    value.diagnostics.utility.available = false;

    const client = fakeClient({snapshot: vi.fn().mockResolvedValue(value)});
    const controller = new PageController(client);

    await startAndFlush(controller);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(client.discover).not.toHaveBeenCalled();
    controller.stop();
  });

  it('does not start automatic discovery while an operation is active', async () => {
    const client = fakeClient({
      snapshot: vi.fn().mockResolvedValueOnce(snapshot())
        .mockResolvedValue(discoverySnapshot()),
      operation: vi.fn().mockResolvedValue(runningOperation),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await controller.discover();
    expect(client.discover).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(client.discover).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('allows one more automatic discovery after backend recovery', async () => {
    const client = fakeClient({
      snapshot: vi.fn()
        .mockResolvedValueOnce(discoverySnapshot())
        .mockRejectedValueOnce(new BackendUnavailable('snapshot'))
        .mockResolvedValue(discoverySnapshot()),
      operation: vi.fn().mockRejectedValue(new SmartApiError(404, 'unknown-operation')),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(1));
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(2));
    controller.stop();
  });

  it.each(
    [
      ['manual', false, {kind: 'busy', code: 'busy'}],
      ['automatic', true, null],
    ] as const,
  )('reports a %s discovery admission error appropriately', async (_name, automatic, expectedNotice) => {
    const client = fakeClient({
      snapshot: vi.fn().mockResolvedValue(automatic ? discoverySnapshot() : snapshot()),
      discover: vi.fn().mockRejectedValue(new SmartApiError(409, 'busy')),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);

    if (automatic) {
      await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(1));
    } else {
      expect(await controller.discover()).toBe('rejected');
    }

    await flush();

    expect(controller.getState().notice).toEqual(expectedNotice);
    expect(controller.getState().backendAvailability).toBe('available');
    controller.stop();
  });

  it('retries automatic discovery after the tab was hidden during the request', async () => {
    let resolveDiscover: ((value: AcceptedOperation) => void) | undefined;
    const client = fakeClient({
      snapshot: vi.fn().mockResolvedValue(discoverySnapshot()),
      discover: vi.fn()
        .mockImplementationOnce(() => {
          return new Promise<AcceptedOperation>((resolve) => {
            resolveDiscover = resolve;
          });
        })
        .mockResolvedValue({schemaVersion: 1, operationId: 'operation-2'}),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(1));

    controller.setVisible(false);
    resolveDiscover?.({schemaVersion: 1, operationId: 'operation-1'});
    await flush();
    await flush();
    controller.setVisible(true);

    await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(2));
    controller.stop();
  });

  describe('empty state', () => {
    const emptySnapshot = (update: (value: Snapshot) => void = () => {}): Snapshot => {
      const value = snapshot();

      value.devices = [];
      update(value);

      return value;
    };
    const finishedOperation = (status: 'succeeded' | 'failed', code?: string): Operation => ({
      ...runningOperation,
      status,
      completedAt: '2026-11-24T10:00:05Z',
      error: code === undefined ? null : {code},
    });

    it.each(
      [
        ['nothing found', (_value: Snapshot) => {}, {kind: 'nothing-found'}],
        ['no utility', (value: Snapshot) => {
          value.diagnostics.utility.available = false;
          value.diagnostics.reasons = ['discovery-not-run'];
        }, {kind: 'no-utility'}],
      ] as const,
    )('is %s for an empty snapshot', async (_name, update, expected) => {
      const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(emptySnapshot(update))}));

      await startAndFlush(controller);

      expect(controller.getState().emptyState).toEqual(expected);
      controller.stop();
    });

    it('is absent while the list has devices', async () => {
      const controller = new PageController(fakeClient());

      await startAndFlush(controller);

      expect(controller.getState().emptyState).toBeNull();
      controller.stop();
    });

    it('is never-ran, not failed, when a terminal backend refused the automatic attempt', async () => {
      const client = fakeClient({
        snapshot: vi.fn().mockResolvedValue(emptySnapshot((value) => {
          value.diagnostics.reasons = ['discovery-not-run'];
        })),
        discover: vi.fn().mockRejectedValue(new BackendNotApproved('discover')),
      });
      const controller = new PageController(client);

      await startAndFlush(controller);
      await vi.waitFor(() => expect(controller.getState().emptyState).toEqual({kind: 'never-ran'}));
      expect(client.discover).toHaveBeenCalledTimes(1);
      controller.stop();
    });

    describe('when the backend is already scanning', () => {
      const busyClient = (afterScan: Snapshot): ReturnType<typeof fakeClient> => {
        return fakeClient({
          snapshot: vi.fn().mockResolvedValueOnce(emptySnapshot((value) => {
            value.diagnostics.reasons = ['discovery-not-run'];
          }))
            .mockResolvedValueOnce(emptySnapshot((value) => {
              value.diagnostics.reasons = ['discovery-not-run'];
            }))
            .mockResolvedValue(afterScan),
          discover: vi.fn().mockRejectedValue(new SmartApiError(409, 'busy')),
        });
      };

      it('follows the scan through the snapshot until its result shows', async () => {
        const controller = new PageController(busyClient(emptySnapshot()));

        await startAndFlush(controller);
        await vi.waitFor(() => expect(controller.getState().emptyState).toEqual({kind: 'searching'}));
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect(controller.getState().emptyState).toEqual({kind: 'searching'});

        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect(controller.getState().emptyState).toEqual({kind: 'nothing-found'});
        controller.stop();
      });

      it('stops following after a bounded number of reads', async () => {
        const client = fakeClient({
          snapshot: vi.fn().mockResolvedValue(emptySnapshot((value) => {
            value.diagnostics.reasons = ['discovery-not-run'];
          })),
          discover: vi.fn().mockRejectedValue(new SmartApiError(409, 'busy')),
        });
        const controller = new PageController(client);

        await startAndFlush(controller);
        await vi.waitFor(() => expect(controller.getState().emptyState).toEqual({kind: 'searching'}));
        await vi.advanceTimersByTimeAsync(130_000);
        await flush();

        expect(controller.getState().emptyState).toEqual({kind: 'never-ran'});
        controller.stop();
      });

      it('keeps following across a hidden tab and settles once it is shown again', async () => {
        const client = busyClient(emptySnapshot());
        const controller = new PageController(client);

        await startAndFlush(controller);
        await vi.waitFor(() => expect(client.discover).toHaveBeenCalledTimes(1));
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        controller.setVisible(false);
        await vi.advanceTimersByTimeAsync(5_000);
        controller.setVisible(true);

        expect(controller.getState().emptyState).toEqual({kind: 'searching'});

        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect(controller.getState().emptyState).toEqual({kind: 'nothing-found'});
        controller.stop();
      });
    });

    it('is searching from the automatic request until the snapshot after the scan', async () => {
      const searched = emptySnapshot();
      const client = fakeClient({
        snapshot: vi.fn().mockResolvedValueOnce(emptySnapshot((value) => {
          value.diagnostics.reasons = ['discovery-not-run'];
        }))
          .mockResolvedValue(searched),
        operation: vi.fn().mockResolvedValueOnce(runningOperation)
          .mockResolvedValue(finishedOperation('succeeded')),
      });
      const controller = new PageController(client);
      const kinds: Array<string | undefined> = [];

      controller.subscribe((state) => kinds.push(state.emptyState?.kind));
      await startAndFlush(controller);
      await vi.waitFor(() => expect(controller.getState().emptyState).toEqual({kind: 'searching'}));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(controller.getState().emptyState).toEqual({kind: 'nothing-found'}));

      expect(kinds).not.toContain('never-ran');
      controller.stop();
    });

    it.each([
      ['a rejected request', {discover: vi.fn().mockRejectedValue(new SmartApiError(500, 'request-failed'))}],
      ['a failed operation', {operation: vi.fn().mockResolvedValue(finishedOperation('failed', 'request-failed'))}],
    ])('is failed after %s and stays failed through later snapshots', async (_name, overrides) => {
      const controller = new PageController(
        fakeClient({snapshot: vi.fn().mockResolvedValue(emptySnapshot()), ...overrides}),
      );

      await startAndFlush(controller);
      await controller.discover();
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();

      expect(controller.getState().emptyState).toEqual({kind: 'failed', code: 'request-failed'});
      controller.stop();
    });

    it('leaves searching when a discovery request ends because the tab was hidden', async () => {
      const client = fakeClient({
        snapshot: vi.fn().mockResolvedValue(emptySnapshot()),
        discover: vi.fn().mockImplementation((_confirmed: boolean, signal: AbortSignal) => {
          return new Promise<AcceptedOperation>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }),
      });
      const controller = new PageController(client);

      await startAndFlush(controller);
      void controller.discover();
      await flush();
      expect(controller.getState().emptyState).toEqual({kind: 'searching'});

      controller.setVisible(false);
      await flush();
      controller.setVisible(true);
      await flush();

      expect(controller.getState().emptyState).toEqual({kind: 'nothing-found'});
      controller.stop();
    });
  });

  it.each([
    ['NVMe protocol', (sample: NonNullable<Snapshot['devices'][number]['sample']>) => {
      sample.protocol = 'nvme';
    }],
    ['SSD rotation rate', (sample: NonNullable<Snapshot['devices'][number]['sample']>) => {
      sample.rotationRate = 0;
    }],
  ])('allows %s read without prior wake consent', async (_name, update) => {
    const value = snapshot();
    const device = value.devices[0];

    if (device?.sample === null || device?.sample === undefined) { throw new Error('fixture sample is missing'); }

    update(device.sample);

    const client = fakeClient({snapshot: vi.fn().mockResolvedValue(value)});
    const controller = new PageController(client);

    await startAndFlush(controller);

    expect(await controller.refresh(false)).toBe('accepted');
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith(device.deviceId, true, expect.any(AbortSignal));
    expect(controller.getState().wakeConsentGranted).toBe(false);
    controller.stop();
  });

  it.each([5200, null])(
    'requires one HDD confirmation per mount for rotation rate %s and clears consent on stop',
    async (rotationRate) => {
      const value = snapshot();

      if (value.devices[0]?.sample === null || value.devices[0]?.sample === undefined) {
        throw new Error('fixture sample is missing');
      }

      value.devices[0].sample.rotationRate = rotationRate;

      const client = fakeClient({snapshot: vi.fn().mockResolvedValue(value)});
      const controller = new PageController(client);

      await startAndFlush(controller);

      expect(await controller.refresh(false)).toBe('rejected');
      expect(client.refresh).not.toHaveBeenCalled();
      expect(await controller.refresh(true)).toBe('accepted');
      expect(controller.getState().wakeConsentGranted).toBe(true);
      expect(await controller.refresh(false)).toBe('accepted');
      expect(client.refresh).toHaveBeenCalledTimes(2);

      controller.stop();
      expect(controller.getState().wakeConsentGranted).toBe(false);
      await startAndFlush(controller);
      expect(controller.getState().wakeConsentGranted).toBe(false);
      expect(await controller.refresh(false)).toBe('rejected');
      controller.stop();
    },
  );

  it('skips a drive confirmation when stored consent exists', async () => {
    const value = snapshot();
    const device = value.devices[0];

    if (device?.sample === null || device?.sample === undefined) { throw new Error('fixture sample is missing'); }

    device.sample.identity = {...device.sample.identity, reliable: true, model: 'ACME HDD', serial: 'SERIAL-1'};

    const key = wakeConsentKey(device.sample);
    const storage = memoryStorage();

    if (key === null) { throw new Error('consent key is missing'); }

    storage.values.set(key, '1');

    const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(value)}), {
      wakeConsentStorage: storage,
    });

    await startAndFlush(controller);
    await flush();

    expect(controller.getState().wakeConsentKeys.has(key)).toBe(true);
    expect(await controller.refresh(false)).toBe('accepted');
    controller.stop();
  });

  it('stores a hashed consent key when the user asks not to be asked again', async () => {
    const value = snapshot();
    const device = value.devices[0];

    if (device?.sample === null || device?.sample === undefined) { throw new Error('fixture sample is missing'); }

    device.sample.identity = {...device.sample.identity, reliable: true, model: 'ACME HDD',
      serial: 'PRIVATE-SERIAL-987'};

    const storage = memoryStorage();
    const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(value)}), {
      wakeConsentStorage: storage,
    });

    await startAndFlush(controller);
    expect(await controller.refresh(true, device.deviceId, true)).toBe('accepted');

    const keys = [...storage.values.keys()];
    const key = keys[0];

    expect(keys).toHaveLength(1);
    expect(key).toMatch(/^wake-consent:[0-9a-f]{16}$/);
    expect(key).not.toContain('PRIVATE-SERIAL-987');
    expect(storage.values.get(key ?? '')).toBe('1');
    expect(controller.getState().wakeConsentKeys.has(key ?? '')).toBe(true);
    expect(await controller.refresh(false)).toBe('accepted');
    controller.stop();
  });

  it('does not unlock another drive with the same model and a different serial', async () => {
    const value = snapshot();
    const first = value.devices[0];

    if (first?.sample === null || first?.sample === undefined) { throw new Error('fixture sample is missing'); }

    first.sample.identity = {...first.sample.identity, reliable: true, model: 'ACME HDD 2TB', serial: 'SERIAL-0001'};

    const second = structuredClone(first);

    if (second.sample === null) { throw new Error('fixture sample is missing'); }

    second.deviceId = 'dev-b';
    second.path = '/dev/sdb';
    second.sample = {...second.sample, deviceId: 'dev-b', identity: {...second.sample.identity, serial: 'SERIAL-0002'}};
    value.devices = [first, second];

    const storage = memoryStorage();
    const firstKey = wakeConsentKey(first.sample);

    if (firstKey === null) { throw new Error('consent key is missing'); }

    storage.values.set(firstKey, '1');

    const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(value)}), {
      wakeConsentStorage: storage,
    });

    await startAndFlush(controller);
    await flush();
    controller.selectDevice(first.deviceId);
    await flush();
    expect(controller.getState().wakeConfirmationRequired).toBe(false);

    controller.selectDevice(second.deviceId);
    await flush();
    expect(controller.getState().wakeConfirmationRequired).toBe(true);
    expect(await controller.refresh(false)).toBe('rejected');
    controller.stop();
  });

  it('keeps the confirmation when loading stored keys fails', async () => {
    const value = snapshot();
    const device = value.devices[0];

    if (device?.sample === null || device?.sample === undefined) { throw new Error('fixture sample is missing'); }

    device.sample.identity = {...device.sample.identity, reliable: true, model: 'ACME HDD', serial: 'SERIAL-1'};

    const storage: WakeConsentStorage = {
      keys: vi.fn().mockRejectedValue(new Error('storage offline')),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(value)}), {
      wakeConsentStorage: storage,
    });

    await startAndFlush(controller);
    await flush();

    expect(controller.getState().wakeConsentKeys.size).toBe(0);
    expect(await controller.refresh(false)).toBe('rejected');
    controller.stop();
  });

  it('keeps the confirmation when saving consent fails', async () => {
    const value = snapshot();
    const device = value.devices[0];

    if (device?.sample === null || device?.sample === undefined) { throw new Error('fixture sample is missing'); }

    device.sample.identity = {...device.sample.identity, reliable: true, model: 'ACME HDD', serial: 'SERIAL-1'};

    const storage: WakeConsentStorage = {
      keys: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockRejectedValue(new Error('storage full')),
    };
    const controller = new PageController(fakeClient({snapshot: vi.fn().mockResolvedValue(value)}), {
      wakeConsentStorage: storage,
    });

    await startAndFlush(controller);
    expect(await controller.refresh(true, device.deviceId, true)).toBe('accepted');
    await flush();

    expect(controller.getState().wakeConsentKeys.size).toBe(0);
    expect(await controller.refresh(false)).toBe('accepted');
    controller.stop();
    await startAndFlush(controller);
    expect(await controller.refresh(false)).toBe('rejected');
    controller.stop();
  });

  it('reports accepted actions and rejects a stale device target', async () => {
    const client = fakeClient();
    const controller = new PageController(client);

    await startAndFlush(controller);
    controller.selectDevice('device-1');
    await flush();

    expect(await controller.discover()).toBe('accepted');
    expect(await controller.refresh(true, 'device-1')).toBe('accepted');
    expect(await controller.setDeviceType('sat', 'device-1')).toBe('accepted');
    expect(await controller.refresh(true, 'other-device')).toBe('rejected');
    expect(await controller.setDeviceType('scsi', 'other-device')).toBe('rejected');
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(client.setDeviceType).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('setDeviceType re-reads snapshot after success', async () => {
    const client = fakeClient();
    const controller = new PageController(client);

    await startAndFlush(controller);
    controller.selectDevice('device-1');
    await flush();
    await controller.setDeviceType('sat');

    expect(client.setDeviceType).toHaveBeenCalledTimes(1);
    expect(client.snapshot).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('rejects a type change invalidated during its follow-up snapshot', async () => {
    let resolveFollowup: ((value: Snapshot) => void) | undefined;
    const followup = new Promise<Snapshot>((resolve) => {
      resolveFollowup = resolve;
    });
    const client = fakeClient({
      snapshot: vi.fn()
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce(snapshot())
        .mockImplementationOnce(() => followup),
    });
    const controller = new PageController(client);

    await startAndFlush(controller);
    controller.selectDevice('device-1');
    await flush();

    const action = controller.setDeviceType('sat', 'device-1');

    await vi.waitFor(() => {
      expect(client.snapshot).toHaveBeenCalledTimes(3);
    });
    controller.setVisible(false);
    resolveFollowup?.(snapshot());

    await expect(action).resolves.toBe('rejected');
    expect(client.setDeviceType).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('setDeviceType explains 409 and does not retry', async () => {
    const client = fakeClient({setDeviceType: vi.fn().mockRejectedValue(new SmartApiError(409, 'busy'))});
    const controller = new PageController(client);

    controller.start();
    controller.selectDevice('device-1');
    await flush();
    expect(await controller.setDeviceType('sat')).toBe('rejected');

    expect(controller.getState().notice).toMatchObject({kind: 'busy', code: 'busy'});
    expect(client.setDeviceType).toHaveBeenCalledTimes(1);
    controller.stop();
  });
});
