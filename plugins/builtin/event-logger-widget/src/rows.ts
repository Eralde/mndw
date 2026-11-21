import type {MndwEvent} from '@mndw/sdk';

export interface EventRow {
  key: number;
  ts: number;
  event?: MndwEvent;
  marker?: 'resumed' | 'resync';
}

export interface RowGroup {
  key: number;
  row: EventRow;
  count: number;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);

  return leftKeys.length === Object.keys(rightRecord).length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
}

function isRepeat(previous: EventRow, next: EventRow): boolean {
  if (previous.event === undefined || next.event === undefined) {
    return false;
  }

  return previous.event.topic === next.event.topic
    && previous.event.source === next.event.source
    && deepEqual(previous.event.payload, next.event.payload);
}

/**
 * Collapses consecutive repeated rows for display only.
 *
 * Rows arrive oldest first, so the last row of a run is the newest one and supplies the displayed time. The group key
 * comes from the run's first (oldest) row and stays stable while the run grows at the end, so an expanded row survives
 * a repeat. If the 500-row cap drops that first row, the key moves to the next surviving row and the row re-renders.
 * Markers never repeat: each resync gap is its own row.
 */
export function groupRows(rows: readonly EventRow[]): RowGroup[] {
  const groups: RowGroup[] = [];

  for (const row of rows) {
    const last = groups.at(-1);

    if (last !== undefined && isRepeat(last.row, row)) {
      groups[groups.length - 1] = {key: last.key, row, count: last.count + 1};

      continue;
    }

    groups.push({key: row.key, row, count: 1});
  }

  return groups;
}
