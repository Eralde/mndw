import {describe, expect, it, vi} from 'vitest';
import type {TelemetryClock} from './telemetry-client.js';
import {TelemetryError, createTelemetryClient, decodeRawSnapshot, historyStatus} from './telemetry-client.js';

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

  it('fetches and strictly decodes annotation sidecars', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          collections: {
            load: [{id: '01J5KZ00000000000000000000', ts: 1, topic: 'wan.connected', label: 'WAN connected'}],
          },
        }),
        {status: 200},
      ),
    );

    const annotations = await createTelemetryClient(fetchImpl).fetchAnnotations();

    expect(annotations.collections.load?.[0]?.label).toBe('WAN connected');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/mndw/telemetry/annotations',
      expect.objectContaining({method: 'GET', cache: 'no-store'}),
    );
  });

  it('rejects malformed annotation sidecars', async () => {
    await expect(
      createTelemetryClient(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({collections: {load: [{id: '', ts: 0}]}}), {status: 200}),
        ),
      ).fetchAnnotations(),
    ).rejects.toBeInstanceOf(TelemetryError);
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

const validStorage = {
  mode: 'ready',
  issues: [],
  journalBytes: 1024,
  journalLimitBytes: 8388608,
  pendingSampleCount: 0,
  oldestPendingSession: null,
  deliveryError: null,
  coverage: [],
  rebuildState: 'idle',
  droppedRecords: {},
};

const validSessionsBody = {sessions: [], storage: validStorage};

const validSessionPageBody = {
  samples: [{
    sequence: '10',
    series: 1,
    elapsedMs: 180000,
    utcMs: null,
    values: [20.5, null],
    disposition: 'retained',
  }],
  nextCursor: null,
  truncated: false,
  truncationReasons: [],
  storage: validStorage,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

describe('telemetry session client', () => {
  it('fetches the session list', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(validSessionsBody)));
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    const list = await client.fetchSessions();

    expect(list.storage.mode).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledWith('/api/mndw/telemetry/sessions', expect.objectContaining({method: 'GET'}));
  });

  it('fetches one session page with a bounded query', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(validSessionPageBody)));
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    const page = await client.fetchSession('s1-01020304050607080910111213141516', {after: 'cursor', limit: 10});

    expect(page.samples).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('limit=10');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('after=cursor');
  });

  it('rejects an unsafe session id before fetching', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(validSessionPageBody)));
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.fetchSession('../etc/passwd')).rejects.toThrow(TelemetryError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an excessive page count before fetching', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(validSessionPageBody)));
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(
      client.fetchSession('s1-01020304050607080910111213141516', {limit: 1001}),
    ).rejects.toThrow(TelemetryError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates non-2xx status including expired cursors', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({error: 'gone'}, 410)));
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(
      client.fetchSession('s1-01020304050607080910111213141516', {after: 'stale'}),
    ).rejects.toMatchObject({status: 410});
  });

  it('reports malformed session payloads as telemetry errors', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({sessions: 'invalid', storage: validStorage})));
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.fetchSessions()).rejects.toThrow(TelemetryError);
  });

  it('propagates cancellation through the signal', async () => {
    const controller = new AbortController();

    controller.abort();

    const fetchImpl = vi.fn((_url: string, options?: {readonly signal?: AbortSignal}): Promise<Response> => {
      if (options?.signal?.aborted) {
        throw new Error('aborted');
      }

      return Promise.resolve(jsonResponse(validSessionsBody));
    });
    const client = createTelemetryClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.fetchSessions({signal: controller.signal})).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/mndw/telemetry/sessions',
      expect.objectContaining({signal: controller.signal}),
    );
  });
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
