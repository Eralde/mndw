import {describe, expect, it} from 'vitest';
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

describe('telemetryService', () => {
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
});
