import {describe, expect, it} from 'vitest';
import {normalizeTransitionLogFrame, parseTransitionTimestamp} from './transition-log-normalizer';

const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime();

describe('normalizeTransitionLogFrame', () => {
  it('normalizes object-keyed native events and all event types', () => {
    const entries = normalizeTransitionLogFrame(
      {log: {
        connected: {timestamp: 'Sep  5 10:04:10', mac: 'client', ap: 'ap-a'},
        left: {timestamp: 'Sep  5 10:03:10', mac: 'client', left: 'ap-a'},
        roam: {timestamp: 'Sep  5 10:02:10', mac: 'client', left: 'ap-a', ap: 'ap-b', roam: 'ft', band: '5'},
        cache: {timestamp: 'Sep  5 10:01:10', mac: 'client', left: 'ap-a', ap: 'ap-b', roam: 'pmk'},
        transition: {timestamp: 'Sep  5 10:00:10', mac: 'client', left: 'ap-a', ap: 'ap-b', segment: 'Bridge1'},
      }},
      {'client': 'Laptop', 'ap-a': 'Living room'},
      NOW,
    );

    expect(entries.map((entry) => entry.eventType)).toEqual([
      'connected',
      'left',
      'fast-transition',
      'pmk-cache',
      'transition',
    ]);
    expect(entries[0]).toMatchObject({client: 'Laptop', from: null, to: 'Living room', id: 'connected'});
    expect(entries[2]).toMatchObject({band: '5'});
  });

  it('treats continued empty frames and invalid events as empty', () => {
    expect(normalizeTransitionLogFrame({continued: true}, {}, NOW)).toEqual([]);
    expect(normalizeTransitionLogFrame({log: {bad: {timestamp: 'invalid', mac: 'client', ap: 'ap'}}}, {}, NOW)).toEqual(
      [],
    );
  });

  it('normalizes the captured endpoint-object and numeric fields', () => {
    const entries = normalizeTransitionLogFrame(
      {log: {
        217: {
          timestamp: 'Aug 16 03:15:41',
          mac: '24:9e:7d:8a:f7:08',
          left: {ap: '52:ff:20:17:9d:5f', band: 0},
          segment: 1,
          id: 217,
        },
        221: {
          timestamp: 'Aug 16 09:15:48',
          mac: 'e6:42:64:7c:86:52',
          ap: '52:ff:20:87:9d:5f',
          band: 1,
          left: {ap: '50:ff:20:c7:9d:5f', band: 0},
          roam: 'ft',
          segment: 0,
          id: 221,
        },
      }},
      {},
      NOW,
    );

    expect(entries[0]).toMatchObject({id: '221', from: '50:ff:20:c7:9d:5f', to: '52:ff:20:87:9d:5f', band: '1',
      segment: '0'});
    expect(entries[1]).toMatchObject({id: '217', from: '52:ff:20:17:9d:5f', to: null, band: '0', segment: '1'});
  });

  it('adjusts timestamps across year boundaries', () => {
    const previousYear = parseTransitionTimestamp('Dec 31 23:59:59', new Date(2026, 0, 1, 0, 0, 0).getTime());
    const nextYear = parseTransitionTimestamp('Jan  1 00:00:01', new Date(2025, 11, 31, 23, 59, 59).getTime());

    expect(new Date(previousYear ?? 0).getFullYear()).toBe(2025);
    expect(new Date(nextYear ?? 0).getFullYear()).toBe(2026);
  });
});
