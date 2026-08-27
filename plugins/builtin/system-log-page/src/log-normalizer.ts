import type {LogLevel, NormalizedLogRecord} from './log-types';

export const DEFAULT_MAX_LINES = 500;

const LOG_LEVELS = new Set<LogLevel>(['Info', 'Warning', 'Error', 'Critical', 'Debug', 'Notice']);

export class SystemLogParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SystemLogParseError';
  }
}

interface RawMessage {
  level?: unknown;
  label?: unknown;
  message?: unknown;
  text?: unknown;
}

interface RawRecord {
  id?: unknown;
  timestamp?: unknown;
  ident?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string') {
    throw new SystemLogParseError(`${path}.${field}: expected a string`);
  }

  return value;
}

function recordId(key: string, value: unknown): number {
  const rawId = value === undefined ? key : value;

  if (typeof rawId !== 'number' && (typeof rawId !== 'string' || !/^\d+$/.test(rawId))) {
    throw new SystemLogParseError(`log.${key}: expected a numeric id`);
  }

  const id = Number(rawId);

  if (!Number.isSafeInteger(id)) {
    throw new SystemLogParseError(`log.${key}: expected a safe integer id`);
  }

  return id;
}

function normalizeRecord(key: string, value: unknown): NormalizedLogRecord {
  if (!isRecord(value)) {
    throw new SystemLogParseError(`log.${key}: expected a record object`);
  }

  const raw = value as RawRecord;
  const timestamp = requiredString(raw.timestamp, 'timestamp', `log.${key}`);
  const ident = requiredString(raw.ident, 'ident', `log.${key}`);

  if (!isRecord(raw.message)) {
    throw new SystemLogParseError(`log.${key}.message: expected an object`);
  }

  const message = raw.message as RawMessage;
  const level = message.level;

  if (typeof level !== 'string' || !LOG_LEVELS.has(level as LogLevel)) {
    throw new SystemLogParseError(`log.${key}.message.level: unknown log level`);
  }

  const text = message.message ?? message.text;

  return {
    id: recordId(key, raw.id),
    timestamp,
    ident,
    level: level as LogLevel,
    label: requiredString(message.label, 'label', `log.${key}.message`),
    text: requiredString(text, 'message', `log.${key}.message`),
  };
}

export function normalizeLogResponse(response: unknown, maxLines = DEFAULT_MAX_LINES): NormalizedLogRecord[] {
  if (!isRecord(response)) {
    throw new SystemLogParseError('show.log: expected an object response');
  }

  if (response.log === undefined) {
    return [];
  }

  if (!isRecord(response.log)) {
    throw new SystemLogParseError('show.log.log: expected a keyed record object');
  }

  const records = Object.entries(response.log).flatMap(([key, value]) => {
    try {
      return [normalizeRecord(key, value)];
    } catch (error) {
      if (error instanceof SystemLogParseError) {
        // Keep one malformed device record from discarding the rest of the snapshot.
        return [];
      }

      throw error;
    }
  });

  records.sort((left, right) => left.id - right.id);

  const limit = Number.isSafeInteger(maxLines) ? Math.max(0, maxLines) : DEFAULT_MAX_LINES;

  return records.slice(-limit);
}
