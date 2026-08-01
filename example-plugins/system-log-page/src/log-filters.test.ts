import {describe, expect, it} from 'vitest';
import type {NormalizedLogRecord} from './log-types';
import {filterRecords, isFilterActive} from './log-filters';

const baseRecord: NormalizedLogRecord = {
  id: 1,
  timestamp: 'Aug  1 12:00:00',
  ident: 'Router',
  level: 'Warning',
  label: 'Warning',
  text: 'Link degraded',
};

const records: NormalizedLogRecord[] = [
  baseRecord,
  {...baseRecord, id: 2, timestamp: 'Aug  1 12:00:01', ident: 'system', level: 'Info', label: 'Info', text: 'Booted'},
  {...baseRecord, id: 3, timestamp: 'Aug  1 12:00:02', ident: 'kernel', level: 'Error', label: 'Error',
    text: 'Disk full'},
];

describe('filterRecords', () => {
  it('matches query case-insensitively across display fields', () => {
    expect(filterRecords(records, {query: 'ROUTER', levels: new Set(['Warning', 'Info', 'Error'])})).toEqual([
      baseRecord,
    ]);
    expect(filterRecords(records, {query: '12:00:00', levels: new Set(['Warning', 'Info', 'Error'])})).toEqual([
      baseRecord,
    ]);
    expect(filterRecords(records, {query: 'disk', levels: new Set(['Warning', 'Info', 'Error'])})).toEqual([
      records[2],
    ]);
  });

  it('composes level filtering with search', () => {
    expect(filterRecords(records, {query: 'o', levels: new Set(['Info'])})).toEqual([records[1]]);
  });

  it('recognizes empty and active filter states', () => {
    const allLevels = new Set(['Info', 'Warning', 'Error', 'Critical', 'Debug'] as const);

    expect(filterRecords(records, {query: '', levels: allLevels})).toEqual(records);
    expect(isFilterActive({query: '', levels: allLevels})).toBe(false);
    expect(isFilterActive({query: 'router', levels: allLevels})).toBe(true);
    expect(isFilterActive({query: '', levels: new Set(['Info'])})).toBe(true);
  });
});
