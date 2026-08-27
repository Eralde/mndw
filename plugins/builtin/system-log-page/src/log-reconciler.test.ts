import {describe, expect, it} from 'vitest';
import type {NormalizedLogRecord} from './log-types';
import {createLogReconciler} from './log-reconciler';

function record(id: number, text: string, level: NormalizedLogRecord['level'] = 'Info'): NormalizedLogRecord {
  return {id, timestamp: 'Aug  1 12:00:00', ident: 'system', level, label: level, text};
}

describe('createLogReconciler', () => {
  it('gives stream data precedence over snapshots in either arrival order', () => {
    const snapshotFirst = createLogReconciler();

    expect(snapshotFirst.merge([record(7, 'snapshot')], 'snapshot')).toEqual([record(7, 'snapshot')]);
    expect(snapshotFirst.merge([record(7, 'stream')], 'stream')).toEqual([record(7, 'stream')]);

    const streamFirst = createLogReconciler();

    expect(streamFirst.merge([record(7, 'stream')], 'stream')).toEqual([record(7, 'stream')]);
    expect(streamFirst.merge([record(7, 'late snapshot')], 'snapshot')).toEqual([record(7, 'stream')]);
  });

  it('merges an out-of-order snapshot and stream without clobbering stream data', () => {
    const reconciler = createLogReconciler();

    reconciler.merge([record(1, 'one'), record(2, 'snapshot two')], 'snapshot');

    expect(reconciler.merge([record(2, 'stream two'), record(3, 'three')], 'stream')).toEqual([
      record(1, 'one'),
      record(2, 'stream two'),
      record(3, 'three'),
    ]);
  });

  it('adds a lower snapshot id without treating it as a stream generation reset', () => {
    const reconciler = createLogReconciler();

    reconciler.merge([record(10, 'stream ten')], 'stream');

    expect(reconciler.merge([record(9, 'snapshot nine'), record(10, 'snapshot ten')], 'snapshot')).toEqual([
      record(9, 'snapshot nine'),
      record(10, 'stream ten'),
    ]);
  });

  it('resets old records when an unseen stream id regresses', () => {
    const reconciler = createLogReconciler();

    reconciler.merge([record(10, 'old generation')], 'stream');

    expect(reconciler.merge([record(3, 'new generation'), record(4, 'new generation')], 'stream')).toEqual([
      record(3, 'new generation'),
      record(4, 'new generation'),
    ]);
  });

  it('does not reset again for a repeated lower stream id already in the generation', () => {
    const reconciler = createLogReconciler();

    reconciler.merge([record(10, 'high'), record(3, 'low')], 'stream');

    expect(reconciler.merge([record(3, 'same low')], 'stream')).toEqual([
      record(3, 'same low'),
      record(10, 'high'),
    ]);
  });

  it('resets markers explicitly and accepts a reused id', () => {
    const reconciler = createLogReconciler();

    reconciler.merge([record(10, 'old')], 'stream');
    expect(reconciler.reset()).toEqual([]);

    expect(reconciler.merge([record(1, 'fresh')], 'stream')).toEqual([record(1, 'fresh')]);
  });

  it('bounds merged state to newest records', () => {
    const reconciler = createLogReconciler();
    const records = Array.from({length: 501}, (_, index) => record(index + 1, `record ${index + 1}`));

    const merged = reconciler.merge(records, 'snapshot');

    expect(merged).toHaveLength(500);
    expect(merged[0]?.id).toBe(2);
    expect(merged[499]?.id).toBe(501);
  });
});
