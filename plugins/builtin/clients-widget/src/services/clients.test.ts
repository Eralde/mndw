import {describe, expect, it, vi} from 'vitest';
import type {RciManager, RciQuery} from '@rci-tools/core';
import {of, throwError} from 'rxjs';
import fixture from '../fixtures/show-device-list.json' with {type: 'json'};
import {type ClientRecord, ClientsParseError, fetchClients, filterVisibleClients, normalizeClients} from './clients.js';

function rawHost(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {mac: '02:7d:4a:91:c3:43', name: 'Client A', active: true, ...over};
}

function wrap(...hosts: unknown[]): unknown {
  return {host: hosts};
}

function names(records: ClientRecord[]): string[] {
  return records.map((record) => record.displayName);
}

describe('normalizeClients — structure', () => {
  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['a missing host key', {}],
    ['a non-array host', {host: {}}],
  ])('throws ClientsParseError for %s', (_label, raw) => {
    expect(() => normalizeClients(raw)).toThrow(ClientsParseError);
  });

  it('throws for a non-object host entry', () => {
    expect(() => normalizeClients(wrap('not-an-object'))).toThrow(ClientsParseError);
  });

  it('names the offending index in the error', () => {
    expect(() => normalizeClients(wrap(rawHost(), null))).toThrow(/host\[1\]/);
  });
});

describe('normalizeClients — mac', () => {
  it('trims and lowercases', () => {
    const [record] = normalizeClients(wrap(rawHost({mac: '  02:7D:4A:91:C3:43  '})));

    expect(record.mac).toBe('02:7d:4a:91:c3:43');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-string', 42],
    ['wrong separator', '02-7d-4a-91-c3-43'],
    ['too short', '02:7d:4a:91:c3'],
    ['non-hex', '02:7d:4a:91:c3:zz'],
  ])('throws ClientsParseError for a %s mac', (_label, mac) => {
    expect(() => normalizeClients(wrap(rawHost({mac})))).toThrow(ClientsParseError);
  });
});

describe('normalizeClients — displayName', () => {
  it('prefers name, then hostname, then mac', () => {
    const records = normalizeClients(wrap(
      rawHost({mac: '02:00:00:00:00:01', name: 'Named', hostname: 'host-a'}),
      rawHost({mac: '02:00:00:00:00:02', name: '', hostname: 'host-b'}),
      rawHost({mac: '02:00:00:00:00:03', name: '   ', hostname: '   '}),
    ));

    expect(names(records)).toEqual(['02:00:00:00:00:03', 'host-b', 'Named']);
  });
});

describe('normalizeClients — optional fields', () => {
  it('keeps well-formed values, accepting numeric strings', () => {
    const [record] = normalizeClients(wrap(rawHost({
      'ip': '192.168.1.46',
      'link': 'down',
      'speed': '1000',
      'port': 2,
      'uptime': 1483,
      'last-seen': '12',
    })));

    expect(record).toMatchObject({
      ip: '192.168.1.46',
      link: 'down',
      uptime: 1483,
      lastSeen: 12,
    });
    expect(record.connection).toEqual({speed: 1000, port: '2'});
  });

  it('nulls missing values rather than throwing', () => {
    const [record] = normalizeClients(wrap(rawHost()));

    expect(record).toMatchObject({
      ip: null,
      link: null,
      uptime: null,
      lastSeen: null,
    });
    expect(record.connection).toEqual({speed: null, port: null});
  });

  it.each([
    ['ip', {ip: ''}, 'ip'],
    ['port', {port: '  '}, 'port'],
    ['speed', {speed: 'fast'}, 'speed'],
    ['uptime', {uptime: Number.NaN}, 'uptime'],
    ['last-seen', {'last-seen': {}}, 'lastSeen'],
    ['link', {link: 'flapping'}, 'link'],
  ])('nulls an invalid %s instead of rejecting the response', (_label, over, field) => {
    const [record] = normalizeClients(wrap(rawHost(over)));

    if (field === 'speed' || field === 'port') {
      expect(record.connection).toMatchObject({[field]: null});
    } else {
      expect(record[field as keyof ClientRecord]).toBeNull();
    }
  });

  it('defaults active to false when missing or non-boolean', () => {
    const records = normalizeClients(wrap(
      rawHost({mac: '02:00:00:00:00:01', active: undefined}),
      rawHost({mac: '02:00:00:00:00:02', active: 'yes'}),
    ));

    expect(records.every((record) => record.active === false)).toBe(true);
  });
});

describe('normalizeClients — mesh filtering', () => {
  it('drops extenders and backhaul links but keeps ordinary clients', () => {
    const records = normalizeClients(fixture);

    expect(names(records)).toEqual(['Client A', 'Former Client A', 'Former Mesh Extender B']);
    expect(names(records)).not.toContain('Mesh Extender A');
    expect(names(records)).not.toContain('Backhaul Link');
  });

  it('retains inactive clients in the fetched set', () => {
    const records = normalizeClients(fixture);

    expect(records.filter((record) => record.active)).toHaveLength(1);
    expect(records.filter((record) => !record.active)).toHaveLength(2);
  });

  it('exposes connection type for active and inactive clients', () => {
    const records = normalizeClients(fixture);

    expect(records.find((record) => record.displayName === 'Client A')?.connectionType).toBe('wired');
    expect(records.find((record) => record.displayName === 'Former Client A')?.connectionType).toBe('unknown');
  });

  it('treats an unknown system-mode as an ordinary client', () => {
    const records = normalizeClients(wrap(rawHost({'system-mode': 'router'})));

    expect(records).toHaveLength(1);
  });
});

describe('normalizeClients — wireless connection', () => {
  it('maps txss, txrate, and rssi from their own source fields', () => {
    const [record] = normalizeClients(wrap(rawHost({
      mws: {ap: 'ap-1', txss: 2, txrate: 866, rssi: -42},
    })));

    expect(record.connection).toEqual({
      accessPointId: 'ap-1',
      bands: ['2'],
      txss: 2,
      txrate: 866,
      rssi: -42,
    });
  });
});

describe('normalizeClients — sorting', () => {
  it('sorts by displayName ascending, locale-aware', () => {
    const records = normalizeClients(wrap(
      rawHost({mac: '02:00:00:00:00:01', name: 'zeta'}),
      rawHost({mac: '02:00:00:00:00:02', name: 'Alpha'}),
      rawHost({mac: '02:00:00:00:00:03', name: 'mike'}),
    ));

    expect(names(records)).toEqual(['Alpha', 'mike', 'zeta']);
  });
});

describe('filterVisibleClients', () => {
  const records = normalizeClients(fixture);

  it('hides inactive clients when showOffline is false', () => {
    expect(names(filterVisibleClients(records, false))).toEqual(['Client A']);
  });

  it('reveals them when showOffline is true, without resurrecting mesh hosts', () => {
    const visible = filterVisibleClients(records, true);

    expect(visible).toHaveLength(3);
    expect(names(visible)).not.toContain('Mesh Extender A');
  });

  it('does not mutate its input', () => {
    filterVisibleClients(records, false);

    expect(records).toHaveLength(3);
  });
});

describe('fetchClients', () => {
  it('issues the exact query and returns normalized records', async () => {
    const queue = vi.fn((_query: RciQuery) => of(fixture));
    const rci = {queue} as unknown as RciManager;

    const records = await fetchClients(rci);

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][0]).toEqual({path: 'show.device-list', extractData: true});
    expect(names(records)).toEqual(['Client A', 'Former Client A', 'Former Mesh Extender B']);
  });

  it('propagates an RCI failure', async () => {
    const rci = {queue: () => throwError(() => new Error('offline'))} as unknown as RciManager;

    await expect(fetchClients(rci)).rejects.toThrow('offline');
  });

  it('propagates a parse failure', async () => {
    const rci = {queue: () => of({host: 'nope'})} as unknown as RciManager;

    await expect(fetchClients(rci)).rejects.toThrow(ClientsParseError);
  });
});
