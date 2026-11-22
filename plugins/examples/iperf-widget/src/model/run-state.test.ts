import {describe, expect, it} from 'vitest';
import {applyServerMessage, initialRunState, startRun, toRunView} from './run-state.js';
import type {ServerMessage} from '../services/test-client.js';

const viewOptions = {
  locale: 'en',
  emptyValue: '—',
  uploadOffsetSeconds: 10,
  label: (key: string): string => key,
  formatPing: (value: number): string => `${value} ms`,
};

describe('run state', () => {
  it('advances through download, upload, and ping while resetting phase speed', () => {
    let state = startRun(initialRunState(1_000), 2_000);

    state = applyServerMessage(state, {type: 'phase', phase: 'download', port: 5201}, 2_100);
    expect(state.speed).toBe(0);
    state = applyServerMessage(state, {
      type: 'interval',
      phase: 'download',
      second: 1,
      bitsPerSecond: 300_000_000,
    }, 2_200);
    expect(state.speed).toBe(300_000_000);

    state = applyServerMessage(state, {type: 'phase', phase: 'upload', port: 5201}, 2_300);
    expect(state.speed).toBe(0);
    state = applyServerMessage(state, {
      type: 'interval',
      phase: 'upload',
      second: 1,
      bitsPerSecond: 200_000_000,
    }, 2_400);
    expect(state.speed).toBe(200_000_000);

    state = applyServerMessage(state, {type: 'phase', phase: 'ping', port: 5201}, 2_500);
    expect(state.phase).toBe('ping');
    expect(state.speed).toBe(0);
    expect(state.latestPingSample).toBeNull();
    expect(state.pingSampleStart).toBe(2_500);
  });

  it('keeps ten ping slots, including null samples, and derives 100/150 ms domains', () => {
    let state = initialRunState(5_000);

    expect(toRunView(state, viewOptions).pingDomain).toEqual({min: 0, max: 100});
    state = applyServerMessage(state, {type: 'pingSample', index: 2, ms: 130}, 5_100);
    state = applyServerMessage(state, {type: 'pingSample', index: 4, ms: null}, 5_200);

    const view = toRunView(state, viewOptions);

    expect(state.pingSamples).toHaveLength(10);
    expect(state.pingSamples[2]).toBe(130);
    expect(state.pingSamples[4]).toBeNull();
    expect(view.pingPoints).toHaveLength(10);
    expect(view.pingPoints[0]).toEqual({time: 5_000, value: 0});
    expect(view.pingPoints[2]).toEqual({time: 5_400, value: 130});
    expect(view.pingPoints[4]).toEqual({time: 5_800, value: 0});
    expect(view.pingDomain).toEqual({min: 0, max: 150});
  });

  it('uses em dashes for missing ping values and summary', () => {
    const state = applyServerMessage(initialRunState(0), {type: 'ping', pingMs: null, jitterMs: null}, 100);
    const view = toRunView(state, viewOptions);

    expect(view.results.ping).toBe('—');
    expect(view.results.jitter).toBe('—');
    expect(view.results.summary).toBe('↓ —  ↑ —  result.ping —');
  });

  it('preserves completed throughput results after stopped and error messages', () => {
    let state = initialRunState(0);

    state = applyServerMessage(state, {type: 'result', phase: 'download', bitsPerSecond: 412_000_000}, 100);
    state = applyServerMessage(state, {type: 'result', phase: 'upload', bitsPerSecond: 188_000_000}, 200);

    const stopped = applyServerMessage(state, {type: 'stopped'}, 300);
    const errored = applyServerMessage(
      state,
      {
        type: 'error',
        code: 'busy',
        message: 'busy',
      } satisfies ServerMessage,
      400,
    );

    expect(stopped.status).toBe('stopped');
    expect(stopped.downloadBps).toBe(412_000_000);
    expect(stopped.uploadBps).toBe(188_000_000);
    expect(toRunView(stopped, viewOptions).results.summary).toContain('412 Mbit/s');
    expect(errored.status).toBe('error');
    expect(errored.statusMessage).toBe('error.busy');
    expect(errored.downloadBps).toBe(412_000_000);
    expect(errored.uploadBps).toBe(188_000_000);
    expect(toRunView(errored, viewOptions).results.summary).toContain('188 Mbit/s');
  });
});
