import {describe, expect, it, vi} from 'vitest';
import {
  type TelemetryClock,
  TelemetryError,
  createTelemetryClient,
  decodeRawSnapshot,
  historyStatus,
} from './telemetry-client.js';

const decodeRawSnapshotForTest = decodeRawSnapshot;

const validBody = {
  keys: {
    cpu: {
      label: 'CPU',
      supported: true,
      unit: 'percent',
      tiers: {
        fine: {stepMs: 180000, samples: [{ts: 1, min: null, max: null, mean: null, ok: false}]},
        coarse: {stepMs: 3600000, samples: []},
      },
    },
  },
  gathering: {enabled: false},
};

const validProjectedBody = {
  keys: {
    cpu: {
      label: 'CPU',
      supported: true,
      unit: 'percent',
      points: [{time: 1, value: 50}, {time: 2, value: null}],
      segments: [{data: [{time: 1, value: 50}]}],
      bands: [{id: 'range-0', data: [{time: 1, min: 40, max: 60}], color: 'accent'}],
      valueDomain: {min: 0, max: 100},
    },
  },
  gathering: {enabled: true},
};

describe('createTelemetryClient', () => {
  it('exposes only snapshot fetchers', () => {
    expect(Object.keys(createTelemetryClient(vi.fn())).sort()).toEqual(['fetchAll', 'fetchProjected']);
  });

  it('decodes nullable values and forwards abort signal', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(validBody), {status: 200}));
    const snapshot = await createTelemetryClient(fetchImpl).fetchAll({signal: controller.signal});

    expect(snapshot.keys.cpu.tiers.fine.samples[0]?.mean).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/mndw/telemetry',
      expect.objectContaining({
        cache: 'no-store',
        signal: controller.signal,
      }),
    );
  });

  it('rejects malformed values and HTTP errors', async () => {
    const malformed = structuredClone(validBody);

    malformed.keys.cpu.tiers.fine.samples[0].min = '0' as never;
    await expect(
      createTelemetryClient(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(malformed), {status: 200}),
        ),
      ).fetchAll(),
    ).rejects.toBeInstanceOf(TelemetryError);

    const invalidSupport = structuredClone(validBody);

    invalidSupport.keys.cpu.supported = 'yes' as never;
    await expect(
      createTelemetryClient(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(invalidSupport), {status: 200}),
        ),
      ).fetchAll(),
    ).rejects.toBeInstanceOf(TelemetryError);
    await expect(
      createTelemetryClient(
        vi.fn().mockResolvedValue(
          new Response('', {status: 503}),
        ),
      ).fetchAll(),
    ).rejects.toMatchObject({status: 503});
  });

  describe('fetchProjected', () => {
    it('sends project=1h query parameter', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(validProjectedBody), {status: 200}),
      );
      const result = await createTelemetryClient(fetchImpl).fetchProjected('1h');

      expect(result.keys.cpu.supported).toBe(true);
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/mndw/telemetry?project=1h',
        expect.objectContaining({method: 'GET', cache: 'no-store'}),
      );
    });

    it('decodes valid projected response and normalizes null to NaN', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(validProjectedBody), {status: 200}),
      );
      const result = await createTelemetryClient(fetchImpl).fetchProjected('7d');

      expect(result.keys.cpu.points[0]?.value).toBe(50);
      expect(result.keys.cpu.points[1]?.value).toBeNaN();
      expect(result.keys.cpu.supported).toBe(true);
      expect(result.keys.cpu.unit).toBe('percent');
      expect(result.keys.cpu.bands[0]?.color).toBe('accent');
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/mndw/telemetry?project=7d',
        expect.objectContaining({method: 'GET', cache: 'no-store'}),
      );
    });

    it('rejects malformed projected series', async () => {
      const malformed = structuredClone(validProjectedBody);

      malformed.keys.cpu.supported = 'yes' as never;

      await expect(
        createTelemetryClient(
          vi.fn().mockResolvedValue(new Response(JSON.stringify(malformed), {status: 200})),
        ).fetchProjected('7d'),
      ).rejects.toBeInstanceOf(TelemetryError);
    });

    it('rejects invalid band color', async () => {
      const malformed = structuredClone(validProjectedBody);

      (malformed.keys.cpu.bands[0] as Record<string, unknown>).color = 'rainbow';

      await expect(
        createTelemetryClient(
          vi.fn().mockResolvedValue(new Response(JSON.stringify(malformed), {status: 200})),
        ).fetchProjected('30d'),
      ).rejects.toBeInstanceOf(TelemetryError);
    });

    it('rejects HTTP errors', async () => {
      await expect(
        createTelemetryClient(
          vi.fn().mockResolvedValue(new Response('', {status: 503})),
        ).fetchProjected('7d'),
      ).rejects.toMatchObject({status: 503});
    });
  });
});

const clockFixture = {
  state: 'anchored',
  historyEndMs: 1800000000000,
  historyCurrent: true,
  replayPending: false,
};

it('decodes optional clock metadata when present', () => {
  const snapshot = decodeRawSnapshotForTest({
    keys: {},
    gathering: {enabled: true},
    clock: clockFixture,
  });

  expect(snapshot.clock).toEqual(clockFixture);
});

it('accepts snapshots without clock metadata', () => {
  const snapshot = decodeRawSnapshotForTest({keys: {}, gathering: {enabled: true}});

  expect(snapshot.clock).toBeUndefined();
});

it('decodes sessionConfigured from raw snapshot', () => {
  const withTrue = decodeRawSnapshotForTest({keys: {}, gathering: {enabled: true}, sessionConfigured: true});

  expect(withTrue.sessionConfigured).toBe(true);

  const withFalse = decodeRawSnapshotForTest({keys: {}, gathering: {enabled: true}, sessionConfigured: false});

  expect(withFalse.sessionConfigured).toBe(false);

  const withoutField = decodeRawSnapshotForTest({keys: {}, gathering: {enabled: true}});

  expect(withoutField.sessionConfigured).toBe(false);
});

it('rejects invalid clock metadata', () => {
  const invalid: readonly Record<string, unknown>[] = [
    {...clockFixture, state: 'unknown'},
    {...clockFixture, historyEndMs: -1},
    {...clockFixture, historyEndMs: 1.5},
    {...clockFixture, historyCurrent: 'yes'},
    {...clockFixture, replayPending: 0},
    {...clockFixture, historyEndMs: null, historyCurrent: true},
  ];

  for (const clock of invalid) {
    expect(() => decodeRawSnapshotForTest({keys: {}, gathering: {enabled: true}, clock})).toThrow();
  }
});

it('does not wrap aborts that happen while decoding the response body', async () => {
  const abortError = new Error('aborted');

  abortError.name = 'AbortError';

  const response = {
    ok: true,
    status: 200,
    json: vi.fn().mockRejectedValue(abortError),
  } as unknown as Response;
  const fetchImpl = vi.fn().mockResolvedValue(response);
  const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

  await expect(client.fetchAll()).rejects.toBe(abortError);
});

const anchoredClock: TelemetryClock = {
  state: 'anchored',
  historyEndMs: 1800000000000,
  historyCurrent: true,
  replayPending: false,
};

describe('historyStatus', () => {
  it('distinguishes catch-up from normal scheduled buffering', () => {
    expect(historyStatus(anchoredClock)).toBe('current');
    expect(historyStatus({...anchoredClock, historyCurrent: false, replayPending: true})).toBe('catching-up');
  });

  it('reports historical when history is not current and nothing is pending', () => {
    expect(historyStatus({...anchoredClock, historyCurrent: false})).toBe('historical');
  });

  it('reports empty history without a dated end', () => {
    expect(historyStatus({...anchoredClock, historyEndMs: null})).toBe('empty');
  });

  it('never claims a legacy response is current', () => {
    expect(historyStatus(undefined)).toBe('legacy');
  });

  it('keeps unknown clock states historical rather than current', () => {
    expect(historyStatus({...anchoredClock, state: 'unanchored', historyCurrent: false})).toBe('historical');
  });
});
