export interface TelemetrySample {
  readonly ts: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly ok: boolean;
}

export interface TelemetryTier {
  readonly stepMs: number;
  readonly samples: readonly TelemetrySample[];
}

export interface TelemetrySeries {
  readonly label?: string;
  readonly supported: boolean;
  readonly unit: 'percent' | 'celsius';
  readonly tiers: Readonly<Record<'fine' | 'coarse', TelemetryTier>>;
}

export interface TelemetrySnapshot {
  readonly keys: Readonly<Record<string, TelemetrySeries>>;
  readonly gathering: {readonly enabled: boolean};
}

export interface TelemetryAnnotation {
  readonly id: string;
  readonly ts: number;
  readonly topic: string;
  readonly label: string;
}

export interface TelemetryAnnotations {
  readonly collections: Readonly<Record<string, readonly TelemetryAnnotation[]>>;
}

export type ProjectRange = '1h' | '3h' | '1d' | '7d' | '30d';

export interface ProjectedPoint {
  readonly time: number;
  readonly value: number;
}

export type ProjectedChartColor = 'accent' | 'success' | 'warning' | 'muted';

export interface ProjectedSegment {
  readonly data: readonly ProjectedPoint[];
}

export interface ProjectedBandPoint {
  readonly time: number;
  readonly min: number;
  readonly max: number;
}

export interface ProjectedBand {
  readonly id: string;
  readonly data: readonly ProjectedBandPoint[];
  readonly color: ProjectedChartColor;
}

export interface ProjectedValueDomain {
  readonly min: number;
  readonly max: number;
}

export interface ProjectedSeries {
  readonly label?: string;
  readonly supported: boolean;
  readonly unit: 'percent' | 'celsius';
  readonly points: readonly ProjectedPoint[];
  readonly segments: readonly ProjectedSegment[];
  readonly bands: readonly ProjectedBand[];
  readonly valueDomain?: ProjectedValueDomain;
}

export interface ProjectedSnapshot {
  readonly keys: Readonly<Record<string, ProjectedSeries>>;
  readonly gathering: {readonly enabled: boolean};
}

export interface TelemetryClient {
  fetchAll(options?: {readonly signal?: AbortSignal}): Promise<TelemetrySnapshot>;
  fetchProjected(range: ProjectRange, options?: {readonly signal?: AbortSignal}): Promise<ProjectedSnapshot>;
  fetchAnnotations(options?: {readonly signal?: AbortSignal}): Promise<TelemetryAnnotations>;
}

export class TelemetryError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TelemetryError';
    this.status = status;
  }
}

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
};

const isPositiveInteger = (value: unknown): value is number => {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
};

const nullableFinite = (value: unknown): number | null => {
  if (value === null) {
    return null;
  }

  if (!isFiniteNumber(value)) {
    throw new Error('telemetry value must be finite or null');
  }

  return value;
};

const decodeTier = (key: string, tierName: 'fine' | 'coarse', rawTier: unknown): TelemetryTier => {
  if (rawTier === null || typeof rawTier !== 'object' || Array.isArray(rawTier)) {
    throw new Error(`telemetry tier ${key}.${tierName} is invalid`);
  }

  const tier = rawTier as Record<string, unknown>;

  if (!isPositiveInteger(tier.stepMs) || !Array.isArray(tier.samples)) {
    throw new Error(`telemetry tier ${key}.${tierName} is invalid`);
  }

  return {
    stepMs: tier.stepMs,
    samples: tier.samples.map((rawSample) => {
      if (rawSample === null || typeof rawSample !== 'object' || Array.isArray(rawSample)) {
        throw new Error(`telemetry sample ${key}.${tierName} is invalid`);
      }

      const sample = rawSample as Record<string, unknown>;

      if (!isPositiveInteger(sample.ts) || typeof sample.ok !== 'boolean') {
        throw new Error(`telemetry sample ${key}.${tierName} is invalid`);
      }

      return {
        ts: sample.ts,
        min: nullableFinite(sample.min),
        max: nullableFinite(sample.max),
        mean: nullableFinite(sample.mean),
        ok: sample.ok,
      };
    }),
  };
};

const decodeSeries = (key: string, rawSeries: unknown): TelemetrySeries => {
  if (rawSeries === null || typeof rawSeries !== 'object' || Array.isArray(rawSeries)) {
    throw new Error(`telemetry series ${key} is invalid`);
  }

  const series = rawSeries as Record<string, unknown>;

  if (series.unit !== 'percent' && series.unit !== 'celsius') {
    throw new Error(`telemetry series ${key} has invalid unit`);
  }

  if (typeof series.supported !== 'boolean') {
    throw new Error(`telemetry series ${key} support is invalid`);
  }

  const rawTiers = series.tiers;

  if (rawTiers === null || typeof rawTiers !== 'object' || Array.isArray(rawTiers)) {
    throw new Error(`telemetry series ${key} tiers are invalid`);
  }

  const tiers = rawTiers as Record<string, unknown>;

  return {
    label: typeof series.label === 'string' ? series.label : undefined,
    supported: series.supported,
    unit: series.unit,
    tiers: {
      fine: decodeTier(key, 'fine', tiers.fine),
      coarse: decodeTier(key, 'coarse', tiers.coarse),
    },
  };
};

const decodeSnapshot = (value: unknown): TelemetrySnapshot => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('telemetry response must be an object');
  }

  const body = value as Record<string, unknown>;
  const gathering = body.gathering;

  if (
    gathering === null || typeof gathering !== 'object' || Array.isArray(gathering)
    || typeof (gathering as Record<string, unknown>).enabled !== 'boolean'
  ) {
    throw new Error('telemetry gathering is invalid');
  }

  const keysValue = body.keys;

  if (keysValue === null || typeof keysValue !== 'object' || Array.isArray(keysValue)) {
    throw new Error('telemetry keys are invalid');
  }

  const keys: Record<string, TelemetrySeries> = {};

  for (const [key, rawSeries] of Object.entries(keysValue as Record<string, unknown>)) {
    keys[key] = decodeSeries(key, rawSeries);
  }

  return {keys, gathering: {enabled: (gathering as Record<string, unknown>).enabled as boolean}};
};

const decodeAnnotations = (value: unknown): TelemetryAnnotations => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('telemetry annotations response must be an object');
  }

  const body = value as Record<string, unknown>;

  if (Object.keys(body).some((key) => key !== 'collections')) {
    throw new Error('telemetry annotations response has unknown fields');
  }

  if (body.collections === null || typeof body.collections !== 'object' || Array.isArray(body.collections)) {
    throw new Error('telemetry annotations collections are invalid');
  }

  const collections: Record<string, readonly TelemetryAnnotation[]> = {};

  for (const [collection, rawAnnotations] of Object.entries(body.collections as Record<string, unknown>)) {
    if (!Array.isArray(rawAnnotations)) {
      throw new Error(`telemetry annotations collection ${collection} is invalid`);
    }

    collections[collection] = rawAnnotations.map((rawAnnotation) => {
      if (rawAnnotation === null || typeof rawAnnotation !== 'object' || Array.isArray(rawAnnotation)) {
        throw new Error(`telemetry annotation ${collection} is invalid`);
      }

      const annotation = rawAnnotation as Record<string, unknown>;

      if (
        Object.keys(annotation).some((key) => !['id', 'ts', 'topic', 'label'].includes(key))
        || typeof annotation.id !== 'string'
        || !isPositiveInteger(annotation.ts)
        || typeof annotation.topic !== 'string'
        || annotation.topic.length === 0
        || typeof annotation.label !== 'string'
        || annotation.label.length === 0
      ) {
        throw new Error(`telemetry annotation ${collection} is invalid`);
      }

      return {
        id: annotation.id,
        ts: annotation.ts,
        topic: annotation.topic,
        label: annotation.label,
      };
    });
  }

  return {collections};
};

const VALID_PROJECTED_COLORS = new Set<ProjectedChartColor>(['accent', 'success', 'warning', 'muted']);

const asProjectedChartColor = (value: unknown): ProjectedChartColor => {
  if (typeof value !== 'string' || !VALID_PROJECTED_COLORS.has(value as ProjectedChartColor)) {
    throw new Error(`invalid projected chart color: ${String(value)}`);
  }

  return value as ProjectedChartColor;
};

const decodeProjectedPoint = (raw: unknown, context: string): ProjectedPoint => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`projected point in ${context} is invalid`);
  }

  const point = raw as Record<string, unknown>;

  if (!isFiniteNumber(point.time)) {
    throw new Error(`projected point time in ${context} is invalid`);
  }

  if (point.value !== null && !isFiniteNumber(point.value)) {
    throw new Error(`projected point value in ${context} must be finite or null`);
  }

  return {time: point.time, value: point.value === null ? Number.NaN : point.value};
};

const decodeProjectedBandPoint = (raw: unknown, context: string): ProjectedBandPoint => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`projected band point in ${context} is invalid`);
  }

  const point = raw as Record<string, unknown>;

  if (!isFiniteNumber(point.time) || !isFiniteNumber(point.min) || !isFiniteNumber(point.max)) {
    throw new Error(`projected band point in ${context} is invalid`);
  }

  return {time: point.time, min: point.min, max: point.max};
};

const decodeProjectedSeries = (key: string, raw: unknown): ProjectedSeries => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`projected series ${key} is invalid`);
  }

  const series = raw as Record<string, unknown>;

  if (typeof series.supported !== 'boolean') {
    throw new Error(`projected series ${key} supported is invalid`);
  }

  if (series.unit !== 'percent' && series.unit !== 'celsius') {
    throw new Error(`projected series ${key} has invalid unit`);
  }

  if (series.label !== undefined && series.label !== null && typeof series.label !== 'string') {
    throw new Error(`projected series ${key} label is invalid`);
  }

  if (!Array.isArray(series.points) || !Array.isArray(series.segments) || !Array.isArray(series.bands)) {
    throw new Error(`projected series ${key} arrays are invalid`);
  }

  const points = series.points.map((point: unknown) => decodeProjectedPoint(point, key));

  const segments: ProjectedSegment[] = (series.segments as unknown[]).map((rawSegment: unknown) => {
    if (rawSegment === null || typeof rawSegment !== 'object' || Array.isArray(rawSegment)) {
      throw new Error(`projected segment in ${key} is invalid`);
    }

    const segment = rawSegment as Record<string, unknown>;

    if (!Array.isArray(segment.data)) {
      throw new Error(`projected segment data in ${key} is invalid`);
    }

    return {data: (segment.data as unknown[]).map((point: unknown) => decodeProjectedPoint(point, key))};
  });

  const bands: ProjectedBand[] = (series.bands as unknown[]).map((rawBand: unknown) => {
    if (rawBand === null || typeof rawBand !== 'object' || Array.isArray(rawBand)) {
      throw new Error(`projected band in ${key} is invalid`);
    }

    const band = rawBand as Record<string, unknown>;

    if (typeof band.id !== 'string' || !Array.isArray(band.data)) {
      throw new Error(`projected band in ${key} is invalid`);
    }

    return {
      id: band.id,
      data: (band.data as unknown[]).map((point: unknown) => decodeProjectedBandPoint(point, key)),
      color: asProjectedChartColor(band.color),
    };
  });

  let valueDomain: ProjectedValueDomain | undefined;

  if (series.valueDomain !== undefined && series.valueDomain !== null) {
    if (typeof series.valueDomain !== 'object' || Array.isArray(series.valueDomain)) {
      throw new Error(`projected series ${key} valueDomain is invalid`);
    }

    const domain = series.valueDomain as Record<string, unknown>;

    if (!isFiniteNumber(domain.min) || !isFiniteNumber(domain.max)) {
      throw new Error(`projected series ${key} valueDomain is invalid`);
    }

    valueDomain = {min: domain.min, max: domain.max};
  }

  return {
    label: typeof series.label === 'string' ? series.label : undefined,
    supported: series.supported,
    unit: series.unit,
    points,
    segments,
    bands,
    valueDomain,
  };
};

const decodeProjectedSnapshot = (value: unknown): ProjectedSnapshot => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('projected telemetry response must be an object');
  }

  const body = value as Record<string, unknown>;
  const gathering = body.gathering;

  if (
    gathering === null || typeof gathering !== 'object' || Array.isArray(gathering)
    || typeof (gathering as Record<string, unknown>).enabled !== 'boolean'
  ) {
    throw new Error('projected telemetry gathering is invalid');
  }

  const keysValue = body.keys;

  if (keysValue === null || typeof keysValue !== 'object' || Array.isArray(keysValue)) {
    throw new Error('projected telemetry keys are invalid');
  }

  const keys: Record<string, ProjectedSeries> = {};

  for (const [key, rawSeries] of Object.entries(keysValue as Record<string, unknown>)) {
    keys[key] = decodeProjectedSeries(key, rawSeries);
  }

  return {keys, gathering: {enabled: (gathering as Record<string, unknown>).enabled as boolean}};
};

export function createTelemetryClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): TelemetryClient {
  return {
    async fetchAll(options = {}): Promise<TelemetrySnapshot> {
      const response = await fetchImpl('/api/mndw/telemetry', {
        method: 'GET',
        cache: 'no-store',
        signal: options.signal,
      });

      if (!response.ok) {
        throw new TelemetryError(response.status, 'Telemetry history is unavailable.');
      }

      try {
        return decodeSnapshot(await response.json());
      } catch (error) {
        throw new TelemetryError(
          response.status,
          error instanceof Error ? error.message : 'Invalid telemetry response.',
        );
      }
    },
    async fetchProjected(
      range: ProjectRange,
      options: {readonly signal?: AbortSignal} = {},
    ): Promise<ProjectedSnapshot> {
      const response = await fetchImpl(`/api/mndw/telemetry?project=${range}`, {
        method: 'GET',
        cache: 'no-store',
        signal: options.signal,
      });

      if (!response.ok) {
        throw new TelemetryError(response.status, 'Projected telemetry is unavailable.');
      }

      try {
        return decodeProjectedSnapshot(await response.json());
      } catch (error) {
        throw new TelemetryError(
          response.status,
          error instanceof Error ? error.message : 'Invalid projected telemetry response.',
        );
      }
    },
    async fetchAnnotations(options = {}): Promise<TelemetryAnnotations> {
      const response = await fetchImpl('/api/mndw/telemetry/annotations', {
        method: 'GET',
        cache: 'no-store',
        signal: options.signal,
      });

      if (!response.ok) {
        throw new TelemetryError(response.status, 'Telemetry annotations are unavailable.');
      }

      try {
        return decodeAnnotations(await response.json());
      } catch (error) {
        throw new TelemetryError(
          response.status,
          error instanceof Error ? error.message : 'Invalid telemetry annotations response.',
        );
      }
    },
  };
}
