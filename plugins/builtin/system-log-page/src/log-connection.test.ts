import {EMPTY, NEVER, Observable, Subject, of, throwError} from 'rxjs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {RciBackgroundProcess} from '@rci-tools/core';
import type {NormalizedLogRecord} from './log-types';
import type {SystemLogApi, SystemLogStream} from './system-log-api';
import {type LogConnectionState, createLogConnectionController} from './log-connection';

interface Session {
  stream: SystemLogStream;
  data: Subject<NormalizedLogRecord[]>;
  done: Subject<void>;
  abort: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  snapshot?: () => Observable<NormalizedLogRecord[]>;
  startStream?: () => SystemLogStream;
}

function record(id: number): NormalizedLogRecord {
  return {id, timestamp: '', ident: '', level: 'Info', label: 'Info', text: `record ${id}`};
}

function session(): Session {
  const data = new Subject<NormalizedLogRecord[]>();
  const done = new Subject<void>();
  const abort = vi.fn(() => true);
  const process = {data$: data.asObservable(), done$: done.asObservable(), state$: NEVER,
    abort} as unknown as RciBackgroundProcess;

  return {stream: {process, data$: data.asObservable()}, data, done, abort};
}

function harness(options: HarnessOptions = {}): {
  api: SystemLogApi;
  batches: Array<{batch: NormalizedLogRecord[]; source: 'snapshot' | 'stream'}>;
  controller: ReturnType<typeof createLogConnectionController>;
  sessions: Session[];
  states: LogConnectionState[];
  showLogOnce: ReturnType<typeof vi.fn>;
  startLogStream: ReturnType<typeof vi.fn>;
} {
  const sessions: Session[] = [];
  const showLogOnce = vi.fn(options.snapshot ?? (() => NEVER));
  const startLogStream = vi.fn(
    options.startStream ?? (() => {
      const nextSession = session();

      sessions.push(nextSession);

      return nextSession.stream;
    }),
  );
  const api: SystemLogApi = {showLogOnce, startLogStream, clearLog: () => NEVER};
  const states: LogConnectionState[] = [];
  const batches: Array<{batch: NormalizedLogRecord[]; source: 'snapshot' | 'stream'}> = [];
  const controller = createLogConnectionController({
    api,
    onBatch: (batch, source) => batches.push({batch, source}),
    onState: (state) => states.push(state),
    timers: {
      setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
      clearInterval: (timer) => globalThis.clearInterval(timer),
    },
  });

  return {api, batches, controller, sessions, states, showLogOnce, startLogStream};
}

function latestState(states: LogConnectionState[]): LogConnectionState | undefined {
  return states.at(-1);
}

describe('log connection controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries with capped delays of 1, 2, 5, 10, 30, then 30 seconds', async () => {
    vi.useFakeTimers();

    const setup = harness();
    const delays = [1, 2, 5, 10, 30, 30];

    setup.controller.start();

    for (const [index, delay] of delays.entries()) {
      setup.sessions[index]?.data.error(new Error('stream closed'));
      expect(latestState(setup.states)?.reconnectSeconds).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay * 1000);
      expect(setup.startLogStream).toHaveBeenCalledTimes(index + 2);
    }

    setup.controller.dispose();
  });

  it('resets backoff on a successful snapshot without cancelling a pending retry', async () => {
    vi.useFakeTimers();

    const pendingSnapshot = new Subject<NormalizedLogRecord[]>();
    let snapshotCalls = 0;
    const setup = harness({
      snapshot: () => {
        snapshotCalls += 1;

        if (snapshotCalls === 5) {
          return pendingSnapshot.asObservable();
        }

        if (snapshotCalls === 6) {
          return of([record(1)]);
        }

        return NEVER;
      },
    });
    const delays = [1, 2, 5, 10];

    setup.controller.start();

    for (const [index, delay] of delays.entries()) {
      setup.sessions[index]?.data.error(new Error('stream closed'));
      await vi.advanceTimersByTimeAsync(delay * 1000);
    }

    setup.sessions[4]?.data.error(new Error('stream closed'));
    expect(latestState(setup.states)?.reconnectSeconds).toBe(30);
    pendingSnapshot.next([record(2)]);
    expect(latestState(setup.states)?.reconnectSeconds).toBe(30);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(setup.startLogStream).toHaveBeenCalledTimes(6);
    expect(setup.batches.at(-1)?.source).toBe('snapshot');
    setup.sessions[5]?.data.error(new Error('stream closed after snapshot'));
    expect(latestState(setup.states)?.reconnectSeconds).toBe(1);

    setup.controller.dispose();
  });

  it('lets manual reconnect reset backoff without waiting for a successful batch', () => {
    vi.useFakeTimers();

    const setup = harness();

    setup.controller.start();
    setup.sessions[0]?.data.error(new Error('first failure'));
    vi.advanceTimersByTime(1000);
    setup.sessions[1]?.data.error(new Error('second failure'));
    expect(latestState(setup.states)?.reconnectSeconds).toBe(2);

    setup.controller.reconnectNow();
    expect(setup.startLogStream).toHaveBeenCalledTimes(3);
    setup.sessions[2]?.data.error(new Error('manual attempt failed'));

    expect(latestState(setup.states)?.reconnectSeconds).toBe(1);
    setup.controller.dispose();
  });

  it('schedules only one retry when data and process terminate together', () => {
    vi.useFakeTimers();

    const setup = harness();

    setup.controller.start();
    setup.sessions[0]?.data.complete();
    setup.sessions[0]?.done.error(new Error('process exited'));

    expect(vi.getTimerCount()).toBe(1);
    expect(latestState(setup.states)?.reconnectSeconds).toBe(1);
    setup.controller.dispose();
  });

  it('keeps snapshot and stream failures separate and schedules one retry', async () => {
    vi.useFakeTimers();

    const setup = harness({snapshot: () => throwError(() => new Error('snapshot failed'))});

    setup.controller.start();
    setup.sessions[0]?.data.error(new Error('stream failed'));

    expect(latestState(setup.states)?.snapshotError).toBe('snapshot failed');
    expect(latestState(setup.states)?.streamError).toBe('stream failed');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.startLogStream).toHaveBeenCalledTimes(2);

    setup.controller.dispose();
  });

  it('ignores stale stream data after a replacement attempt starts', async () => {
    vi.useFakeTimers();

    const setup = harness();

    setup.controller.start();
    setup.sessions[0]?.data.error(new Error('replace this attempt'));
    await vi.advanceTimersByTimeAsync(1000);
    setup.sessions[0]?.data.next([record(1)]);
    setup.sessions[1]?.data.next([record(2)]);

    expect(setup.batches).toEqual([{batch: [record(2)], source: 'stream'}]);
    setup.controller.dispose();
  });

  it('unsubscribes pending snapshot and stream and aborts a connected process on disposal', () => {
    const teardown = {snapshot: vi.fn(), stream: vi.fn(), process: vi.fn()};
    const process = {
      data$: NEVER,
      done$: new Observable<void>(() => teardown.process),
      state$: NEVER,
      abort: vi.fn(() => true),
    } as unknown as RciBackgroundProcess;
    const stream: SystemLogStream = {
      process,
      data$: new Observable<NormalizedLogRecord[]>(() => teardown.stream),
    };
    const setup = harness({
      snapshot: () => new Observable<NormalizedLogRecord[]>(() => teardown.snapshot),
      startStream: () => stream,
    });

    setup.controller.start();
    setup.controller.dispose();

    expect(teardown.snapshot).toHaveBeenCalledTimes(1);
    expect(teardown.stream).toHaveBeenCalledTimes(1);
    expect(teardown.process).toHaveBeenCalledTimes(1);
    expect(process.abort.mock.calls).toHaveLength(1);
  });

  it('does not reconnect after disposal during backoff', () => {
    vi.useFakeTimers();

    const setup = harness();

    setup.controller.start();
    setup.sessions[0]?.data.error(new Error('stream closed'));
    setup.controller.dispose();
    vi.advanceTimersByTime(60_000);

    expect(setup.startLogStream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the replacement attempt reconnecting until live stream data arrives', async () => {
    vi.useFakeTimers();

    const setup = harness();

    setup.controller.start();
    setup.sessions[0]?.data.error(new Error('stream closed'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(latestState(setup.states)?.status).toBe('reconnecting');
    expect(latestState(setup.states)?.streamError).toBe('stream closed');

    setup.sessions[1]?.data.next([record(1)]);

    expect(latestState(setup.states)?.status).toBe('connected');
    expect(latestState(setup.states)?.streamError).toBe('');
    setup.controller.dispose();
  });

  it('handles synchronous stream completion and process completion with one retry timer', () => {
    vi.useFakeTimers();

    const process = {
      data$: NEVER,
      done$: of(undefined),
      state$: NEVER,
      abort: vi.fn(() => true),
    } as unknown as RciBackgroundProcess;
    const stream: SystemLogStream = {process, data$: EMPTY};
    const setup = harness({startStream: () => stream});

    setup.controller.start();

    expect(latestState(setup.states)?.reconnectSeconds).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    setup.controller.dispose();
  });

  it('schedules recovery and still starts snapshot when stream setup throws synchronously', () => {
    vi.useFakeTimers();

    const startStream = vi.fn(() => {
      throw new Error('stream setup failed');
    });
    const snapshot = vi.fn(() => NEVER);
    const setup = harness({startStream, snapshot});

    setup.controller.start();

    expect(latestState(setup.states)?.status).toBe('error');
    expect(latestState(setup.states)?.streamError).toBe('stream setup failed');
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    setup.controller.dispose();
  });
});
