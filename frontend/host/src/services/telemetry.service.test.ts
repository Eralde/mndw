import {describe, expect, it} from 'vitest';
import type {TelemetryClock} from '@mndw/sdk';
import {createTelemetryService} from './telemetry.service.js';

function mockFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {'Content-Type': 'application/json'},
      }),
    );
}

const SNAPSHOT_WITH_CLOCK = {
  gathering: {enabled: true},
  keys: {},
  clock: {
    state: 'anchored',
    historyEndMs: 1800000000000,
    historyCurrent: true,
    replayPending: false,
  } satisfies TelemetryClock,
};

describe('telemetryService', () => {
  it('preserves clock metadata through facade', async () => {
    const service = createTelemetryService(mockFetch(SNAPSHOT_WITH_CLOCK));
    const snapshot = await service.fetchAll();

    expect(snapshot.clock).toBeDefined();
    expect(snapshot.clock?.state).toBe('anchored');
    expect(snapshot.clock?.historyEndMs).toBe(1800000000000);
    expect(snapshot.clock?.historyCurrent).toBe(true);
    expect(snapshot.clock?.replayPending).toBe(false);
  });

  it('decodes projected snapshot with clock metadata', async () => {
    const projected = {
      gathering: {enabled: true},
      keys: {},
      clock: {
        state: 'suspect',
        historyEndMs: null,
        historyCurrent: false,
        replayPending: true,
      },
    };
    const service = createTelemetryService(mockFetch(projected));
    const snapshot = await service.fetchProjected('7d');

    expect(snapshot.clock).toBeDefined();
    expect(snapshot.clock?.state).toBe('suspect');
    expect(snapshot.clock?.historyEndMs).toBeNull();
  });

  it('returns undefined clock for legacy responses', async () => {
    const legacy = {gathering: {enabled: true}, keys: {}};
    const service = createTelemetryService(mockFetch(legacy));
    const snapshot = await service.fetchAll();

    expect(snapshot.clock).toBeUndefined();
  });
});
