import {describe, expect, it, vi} from 'vitest';
import {
  KNOWN_TELEMETRY_UNITS,
  type TelemetryClock,
  TelemetryError,
  createTelemetryClient,
  historyStatus,
  isKnownTelemetryUnit,
} from './telemetry-client.js';

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
  it('exposes only fetchProjected', () => {
    expect(Object.keys(createTelemetryClient(vi.fn()))).toEqual(['fetchProjected']);
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

    it('accepts and preserves an unknown non-empty unit', async () => {
      const body = structuredClone(validProjectedBody);

      (body.keys.cpu as Record<string, unknown>).unit = 'widgets/hour';

      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {status: 200}));
      const result = await createTelemetryClient(fetchImpl).fetchProjected('1h');

      expect(result.keys.cpu.unit).toBe('widgets/hour');
    });

    it.each(['', 17, null, undefined])('rejects an invalid unit value: %s', async (unit) => {
      const body = structuredClone(validProjectedBody);

      (body.keys.cpu as Record<string, unknown>).unit = unit;

      await expect(
        createTelemetryClient(
          vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {status: 200})),
        ).fetchProjected('1h'),
      ).rejects.toBeInstanceOf(TelemetryError);
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

describe('telemetry units', () => {
  it('lists known units and identifies them with the guard', () => {
    expect(KNOWN_TELEMETRY_UNITS).toEqual(['percent', 'celsius']);
    expect(isKnownTelemetryUnit('percent')).toBe(true);
    expect(isKnownTelemetryUnit('celsius')).toBe(true);
    expect(isKnownTelemetryUnit('widgets/hour')).toBe(false);
  });
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

  await expect(client.fetchProjected('7d')).rejects.toBe(abortError);
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
