import {describe, expect, it} from 'vitest';
import type {MndwEvent} from '@mndw/sdk';
import {type EventRow, groupRows} from './rows.js';

function daemonUpdated(ts: number, version = '1.0.0'): MndwEvent {
  return {id: `daemon-${ts}`, ts, topic: 'daemon.updated', source: 'internal', payload: {version}};
}

function eventRow(key: number, event: MndwEvent): EventRow {
  return {key, ts: event.ts, event};
}

function dnsRow(key: number, resolvers: string[]): EventRow {
  return eventRow(key, {
    id: `dns-${key}`,
    ts: key,
    topic: 'net.dns_changed',
    source: 'log',
    payload: {resolvers},
  });
}

function markerRow(key: number): EventRow {
  return {key, ts: key, marker: 'resync'};
}

describe('groupRows', () => {
  it('collapses consecutive repeats, keeping the newest row and the oldest key', () => {
    const groups = groupRows([
      eventRow(1, daemonUpdated(10)),
      eventRow(2, daemonUpdated(20)),
      eventRow(3, daemonUpdated(30)),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe(1);
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.row.ts).toBe(30);
  });

  it('keeps a growing run keyed by its oldest row', () => {
    const before = groupRows([eventRow(1, daemonUpdated(10)), eventRow(2, daemonUpdated(20))]);
    const after = groupRows([
      eventRow(1, daemonUpdated(10)),
      eventRow(2, daemonUpdated(20)),
      eventRow(3, daemonUpdated(30)),
    ]);

    expect(after).toHaveLength(1);
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.count).toBe(3);
    expect(after[0]?.row.ts).toBe(30);
  });

  it('compares payloads deeply and splits non-consecutive or different rows', () => {
    expect(groupRows([dnsRow(1, ['a', 'b']), dnsRow(2, ['a', 'b'])])).toHaveLength(1);
    expect(groupRows([dnsRow(1, ['a', 'b']), dnsRow(2, ['b', 'a'])])).toHaveLength(2);
    expect(groupRows([
      eventRow(1, daemonUpdated(10, '2.0.0')),
      eventRow(2, daemonUpdated(20, '1.0.0')),
      eventRow(3, daemonUpdated(30, '2.0.0')),
    ])).toHaveLength(3);
  });

  it('never groups marker rows', () => {
    expect(groupRows([markerRow(1), markerRow(2)])).toHaveLength(2);
  });
});
