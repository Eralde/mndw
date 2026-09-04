import {describe, expect, it, vi} from 'vitest';
import {TelemetryError, createTelemetryClient} from './telemetry-client.js';

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
