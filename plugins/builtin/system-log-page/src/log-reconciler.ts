import {DEFAULT_MAX_LINES} from './log-normalizer';
import type {NormalizedLogRecord} from './log-types';

export type LogRecordSource = 'snapshot' | 'stream';

export interface LogReconciler {
  merge(records: readonly NormalizedLogRecord[], source: LogRecordSource): NormalizedLogRecord[];
  reset(): NormalizedLogRecord[];
}

function capValue(maxLines: number): number {
  return Number.isSafeInteger(maxLines) ? Math.max(0, maxLines) : DEFAULT_MAX_LINES;
}

export function createLogReconciler(maxLines = DEFAULT_MAX_LINES): LogReconciler {
  const limit = capValue(maxLines);
  const records = new Map<number, NormalizedLogRecord>();
  const seenIds = new Set<number>();
  const streamIds = new Set<number>();
  let streamHighWaterMark: number | undefined;

  function clearState(): void {
    records.clear();
    seenIds.clear();
    streamIds.clear();
    streamHighWaterMark = undefined;
  }

  function trimState(): void {
    const ids = [...records.keys()].sort((left, right) => left - right);

    while (ids.length > limit) {
      const id = ids.shift();

      if (id === undefined) {
        break;
      }

      records.delete(id);
      seenIds.delete(id);
      streamIds.delete(id);
    }
  }

  function current(): NormalizedLogRecord[] {
    return [...records.values()].sort((left, right) => left.id - right.id);
  }

  function merge(recordsToMerge: readonly NormalizedLogRecord[], source: LogRecordSource): NormalizedLogRecord[] {
    const highWaterMark = streamHighWaterMark;

    if (
      source === 'stream'
      && highWaterMark !== undefined
      && recordsToMerge.some((record) => record.id < highWaterMark && !seenIds.has(record.id))
    ) {
      clearState();
    }

    for (const record of recordsToMerge) {
      seenIds.add(record.id);

      if (source === 'stream') {
        records.set(record.id, record);
        streamIds.add(record.id);
        streamHighWaterMark = Math.max(streamHighWaterMark ?? record.id, record.id);
      } else if (!streamIds.has(record.id)) {
        records.set(record.id, record);
      }
    }

    trimState();

    return current();
  }

  return {
    merge,
    reset(): NormalizedLogRecord[] {
      clearState();

      return [];
    },
  };
}
