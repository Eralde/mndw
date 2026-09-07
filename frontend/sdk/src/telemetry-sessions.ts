import type {TelemetrySessionFetchOptions} from './telemetry-client.js';

export type TelemetrySessionState = 'unanchored' | 'anchored' | 'mixed';
export type TelemetrySessionDisposition = 'retained' | 'pending' | 'conflict' | 'unproven';

export interface TelemetrySessionSummary {
  readonly id: string;
  readonly bootOrder: string;
  readonly elapsedStartMs: number;
  readonly elapsedEndMs: number;
  readonly sampleCount: number;
  readonly conflictCount: number;
  readonly state: TelemetrySessionState;
  readonly utcStartMs: number | null;
  readonly utcEndMs: number | null;
}

export interface TelemetrySessionSample {
  readonly sequence: string;
  readonly series: number;
  readonly elapsedMs: number;
  readonly utcMs: number | null;
  readonly values: readonly (number | null)[];
  readonly disposition: TelemetrySessionDisposition;
}

export interface TelemetryRecoveryIssue {
  readonly code: string;
  readonly firstSequence: string | null;
  readonly lastSequence: string | null;
}

export interface TelemetryCoverage {
  readonly series: number;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly edgeComplete: boolean;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export interface TelemetryStorageStatus {
  readonly mode: string;
  readonly issues: readonly TelemetryRecoveryIssue[];
  readonly journalBytes: number | null;
  readonly journalLimitBytes: number;
  readonly pendingSampleCount: number | null;
  readonly oldestPendingSession: string | null;
  readonly deliveryError: string | null;
  readonly coverage: readonly TelemetryCoverage[];
  readonly rebuildState: string;
  readonly droppedRecords: Readonly<Record<string, string>>;
}

export interface TelemetrySessionList {
  readonly sessions: readonly TelemetrySessionSummary[];
  readonly storage: TelemetryStorageStatus;
}

export interface TelemetrySessionPage {
  readonly samples: readonly TelemetrySessionSample[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly storage: TelemetryStorageStatus;
}

const maxSessions = 64;
const maxSamples = 1000;
const maxSampleValues = 64;
const maxReasons = 16;

const sessionStates: readonly TelemetrySessionState[] = ['unanchored', 'anchored', 'mixed'];
const dispositions: readonly TelemetrySessionDisposition[] = ['retained', 'pending', 'conflict', 'unproven'];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
};

const requireNumber = (value: unknown, field: string): number => {
  if (!isFiniteNumber(value)) {
    throw new Error(`telemetry sessions ${field} must be a finite number`);
  }

  return value;
};

const nullableNumber = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return requireNumber(value, field);
};

const nullableString = (value: unknown, field: string, limit: number): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new Error(`telemetry sessions ${field} must be a bounded string or null`);
  }

  return value;
};

const requireString = (value: unknown, field: string, limit: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new Error(`telemetry sessions ${field} must be a bounded string`);
  }

  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`telemetry sessions ${field} must be a boolean`);
  }

  return value;
};

const requireArray = (value: unknown, field: string, limit: number): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`telemetry sessions ${field} must be an array`);
  }

  if (value.length > limit) {
    throw new Error(`telemetry sessions ${field} exceeds ${limit} entries`);
  }

  return value as readonly unknown[];
};

// validateSessionId accepts only the canonical session identifier so a hostile
// value can never traverse the session route.
export const validateSessionId = (id: string): void => {
  if (!/^s1-[0-9a-f]{32}$/.test(id)) {
    throw new Error('telemetry session id is invalid');
  }
};

// validateSessionOptions bounds a page request before it reaches the daemon.
export const validateSessionOptions = (options: TelemetrySessionFetchOptions): void => {
  const {limit, after} = options;

  if (limit !== undefined) {
    if (!isFiniteNumber(limit) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('telemetry session limit must be an integer between 1 and 1000');
    }
  }

  if (after !== undefined && (typeof after !== 'string' || after.length === 0 || after.length > 128)) {
    throw new Error('telemetry session cursor is invalid');
  }
};

const decodeStorage = (raw: unknown): TelemetryStorageStatus => {
  if (!isRecord(raw)) {
    throw new Error('telemetry sessions storage must be an object');
  }

  const dropped: Record<string, string> = {};

  if (raw.droppedRecords !== null && raw.droppedRecords !== undefined) {
    if (!isRecord(raw.droppedRecords)) {
      throw new Error('telemetry sessions droppedRecords must be an object');
    }

    for (const [key, value] of Object.entries(raw.droppedRecords)) {
      dropped[key] = typeof value === 'string' ? value : String(value);
    }
  }

  return {
    mode: requireString(raw.mode, 'storage mode', 32),
    issues: requireArray(raw.issues ?? [], 'storage issues', maxReasons).map((entry) => {
      if (!isRecord(entry)) {
        throw new Error('telemetry sessions issue must be an object');
      }

      return {
        code: requireString(entry.code, 'issue code', 64),
        firstSequence: nullableString(entry.firstSequence, 'issue firstSequence', 32),
        lastSequence: nullableString(entry.lastSequence, 'issue lastSequence', 32),
      };
    }),
    journalBytes: nullableNumber(raw.journalBytes, 'journalBytes'),
    journalLimitBytes: requireNumber(raw.journalLimitBytes ?? 0, 'journalLimitBytes'),
    pendingSampleCount: nullableNumber(raw.pendingSampleCount, 'pendingSampleCount'),
    oldestPendingSession: nullableString(raw.oldestPendingSession, 'oldestPendingSession', 64),
    deliveryError: nullableString(raw.deliveryError, 'deliveryError', 256),
    coverage: requireArray(raw.coverage ?? [], 'storage coverage', maxReasons).map((entry) => {
      if (!isRecord(entry)) {
        throw new Error('telemetry sessions coverage must be an object');
      }

      return {
        series: requireNumber(entry.series ?? 0, 'coverage series'),
        startMs: nullableNumber(entry.startMs, 'coverage startMs'),
        endMs: nullableNumber(entry.endMs, 'coverage endMs'),
        edgeComplete: requireBoolean(entry.edgeComplete ?? false, 'coverage edgeComplete'),
        complete: requireBoolean(entry.complete ?? false, 'coverage complete'),
        reasons: requireArray(entry.reasons ?? [], 'coverage reasons', maxReasons).map((reason) =>
          requireString(reason, 'coverage reason', 64)
        ),
      };
    }),
    rebuildState: typeof raw.rebuildState === 'string' ? raw.rebuildState : '',
    droppedRecords: dropped,
  };
};

export const decodeSessionList = (value: unknown): TelemetrySessionList => {
  if (!isRecord(value)) {
    throw new Error('telemetry session list must be an object');
  }

  const sessions = requireArray(value.sessions, 'sessions', maxSessions).map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('telemetry session summary must be an object');
    }

    const state = entry.state;

    if (typeof state !== 'string' || !sessionStates.includes(state as TelemetrySessionState)) {
      throw new Error('telemetry session state is invalid');
    }

    const bootOrder = requireString(entry.bootOrder, 'bootOrder', 32);

    if (!/^[0-9]+$/.test(bootOrder)) {
      throw new Error('telemetry session bootOrder must be a decimal string');
    }

    return {
      id: requireString(entry.id, 'session id', 64),
      bootOrder,
      elapsedStartMs: requireNumber(entry.elapsedStartMs ?? 0, 'elapsedStartMs'),
      elapsedEndMs: requireNumber(entry.elapsedEndMs ?? 0, 'elapsedEndMs'),
      sampleCount: requireNumber(entry.sampleCount ?? 0, 'sampleCount'),
      conflictCount: requireNumber(entry.conflictCount ?? 0, 'conflictCount'),
      state: state as TelemetrySessionState,
      utcStartMs: nullableNumber(entry.utcStartMs, 'utcStartMs'),
      utcEndMs: nullableNumber(entry.utcEndMs, 'utcEndMs'),
    };
  });

  return {sessions, storage: decodeStorage(value.storage)};
};

export const decodeSessionPage = (value: unknown): TelemetrySessionPage => {
  if (!isRecord(value)) {
    throw new Error('telemetry session page must be an object');
  }

  const samples = requireArray(value.samples, 'samples', maxSamples).map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('telemetry session sample must be an object');
    }

    const sequence = requireString(entry.sequence, 'sequence', 32);

    if (!/^[0-9]+$/.test(sequence)) {
      throw new Error('telemetry session sequence must be a decimal string');
    }

    const disposition = entry.disposition;

    if (
      typeof disposition !== 'string'
      || !dispositions.includes(disposition as TelemetrySessionDisposition)
    ) {
      throw new Error('telemetry session disposition is invalid');
    }

    return {
      sequence,
      series: requireNumber(entry.series ?? 0, 'series'),
      elapsedMs: requireNumber(entry.elapsedMs ?? 0, 'elapsedMs'),
      utcMs: nullableNumber(entry.utcMs, 'utcMs'),
      values: requireArray(entry.values ?? [], 'values', maxSampleValues).map((point) =>
        nullableNumber(point, 'value')
      ),
      disposition: disposition as TelemetrySessionDisposition,
    };
  });

  return {
    samples,
    nextCursor: nullableString(value.nextCursor, 'nextCursor', 128),
    truncated: requireBoolean(value.truncated ?? false, 'truncated'),
    truncationReasons: requireArray(value.truncationReasons ?? [], 'truncationReasons', maxReasons).map((
      reason,
    ) => requireString(reason, 'truncation reason', 64)),
    storage: decodeStorage(value.storage),
  };
};
