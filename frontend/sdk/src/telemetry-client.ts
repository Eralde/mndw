import type {Observable} from 'rxjs';

export type TelemetryClockState = 'unanchored' | 'anchored' | 'suspect';

export interface TelemetryClock {
  readonly state: TelemetryClockState;
  readonly historyEndMs: number | null;
  readonly historyCurrent: boolean;
  readonly replayPending: boolean;
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

export type KnownTelemetryUnit = 'percent' | 'celsius';
export type TelemetryUnit = KnownTelemetryUnit | (string & {});

export const KNOWN_TELEMETRY_UNITS: readonly KnownTelemetryUnit[] = ['percent', 'celsius'];

export const isKnownTelemetryUnit = (unit: string): unit is KnownTelemetryUnit => {
  return KNOWN_TELEMETRY_UNITS.includes(unit as KnownTelemetryUnit);
};

export interface ProjectedSeries {
  readonly label?: string;
  readonly supported: boolean;
  readonly unit: TelemetryUnit;
  readonly points: readonly ProjectedPoint[];
  readonly segments: readonly ProjectedSegment[];
  readonly bands: readonly ProjectedBand[];
  readonly valueDomain?: ProjectedValueDomain;
}

export interface ProjectedSnapshot {
  readonly keys: Readonly<Record<string, ProjectedSeries>>;
  readonly gathering: {readonly enabled: boolean};
  readonly clock?: TelemetryClock;
  readonly sessionConfigured: boolean;
}

export interface TelemetryClient {
  fetchProjected(range: ProjectRange, options?: {readonly signal?: AbortSignal}): Promise<ProjectedSnapshot>;
}

export interface TelemetryGathering {
  readonly enabled: boolean;
}

export interface PluginTelemetry extends TelemetryClient {
  /** Emits the current gathering state once it is known, then every change; completes on unmount. */
  readonly gathering$: Observable<TelemetryGathering>;
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

const clockStates: readonly TelemetryClockState[] = ['unanchored', 'anchored', 'suspect'];

const decodeClock = (raw: unknown): TelemetryClock | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('telemetry clock is invalid');
  }

  const body = raw as Record<string, unknown>;
  const {state, historyEndMs, historyCurrent, replayPending} = body;

  if (typeof state !== 'string' || !clockStates.includes(state as TelemetryClockState)) {
    throw new Error('telemetry clock state is invalid');
  }

  if (historyEndMs !== null && (!isFiniteNumber(historyEndMs) || !Number.isInteger(historyEndMs) || historyEndMs < 0)) {
    throw new Error('telemetry clock historyEndMs must be a non-negative integer or null');
  }

  if (typeof historyCurrent !== 'boolean' || typeof replayPending !== 'boolean') {
    throw new Error('telemetry clock flags must be booleans');
  }

  if (historyEndMs === null && historyCurrent) {
    throw new Error('telemetry clock cannot be current without history');
  }

  return {state: state as TelemetryClockState, historyEndMs, historyCurrent, replayPending};
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

  if (typeof series.unit !== 'string' || series.unit.length === 0) {
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

  return {
    keys,
    gathering: {enabled: (gathering as Record<string, unknown>).enabled as boolean},
    clock: decodeClock(body.clock),
    sessionConfigured: typeof body.sessionConfigured === 'boolean' ? body.sessionConfigured : false,
  };
};

interface TelemetryRequestOptions {
  readonly signal?: AbortSignal;
  readonly unavailableMessage: string;
  readonly invalidResponseMessage: string;
}

const isAbortError = (error: unknown): boolean => {
  return error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
};

export function createTelemetryClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): TelemetryClient {
  const request = async <T>(
    url: string,
    decoder: (value: unknown) => T,
    options: TelemetryRequestOptions,
  ): Promise<T> => {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      signal: options.signal,
    });

    if (!response.ok) {
      throw new TelemetryError(response.status, options.unavailableMessage);
    }

    try {
      return decoder(await response.json());
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      throw new TelemetryError(
        response.status,
        error instanceof Error ? error.message : options.invalidResponseMessage,
      );
    }
  };

  return {
    async fetchProjected(
      range: ProjectRange,
      options: {readonly signal?: AbortSignal} = {},
    ): Promise<ProjectedSnapshot> {
      return request(
        `/api/mndw/telemetry?project=${range}`,
        decodeProjectedSnapshot,
        {
          signal: options.signal,
          unavailableMessage: 'Projected telemetry is unavailable.',
          invalidResponseMessage: 'Invalid projected telemetry response.',
        },
      );
    },
  };
}

export type HistoryStatus = 'current' | 'catching-up' | 'historical' | 'empty' | 'legacy';

export function historyStatus(clock: TelemetryClock | undefined): HistoryStatus {
  if (clock === undefined) {
    return 'legacy';
  }

  if (clock.historyEndMs === null) {
    return 'empty';
  }

  if (clock.historyCurrent) {
    return 'current';
  }

  return clock.replayPending ? 'catching-up' : 'historical';
}
