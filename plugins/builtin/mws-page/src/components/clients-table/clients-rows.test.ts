import {describe, expect, it} from 'vitest';
import type {MwsClient, MwsNode} from '../../domain/mws/mws.types';
import {buildClientRows, filterRows, sortRows} from './clients-rows';

function client(
  mac: string,
  name: string,
  ip: string | null,
  uptime: number | null,
  wired: boolean,
): MwsClient {
  return {mac, name, ip, uptime, lastSeen: null, wired, active: true};
}

function node(id: string, name: string, clients: MwsClient[] = [], children: MwsNode[] = []): MwsNode {
  return {
    id,
    cid: null,
    name,
    model: null,
    ip: null,
    mac: id,
    isController: false,
    isOnline: true,
    fw: null,
    fwAvailable: null,
    system: null,
    backhaul: null,
    parent: null,
    children: children.map((child) => ({type: 'wired', node: child})),
    clients,
  };
}

function fixtureRoots(): MwsNode[] {
  const child = node('child-a', 'Child-A', [client('client-3', 'Gamma', '10.0.0.3', 30, true)]);
  const rootA = node('root-a', 'Root-A', [
    client('client-1', 'Alpha', '10.0.0.2', 20, false),
    client('client-2', 'Beta', '10.0.0.10', null, true),
  ], [child]);
  const rootB = node('root-b', 'Root-B', [client('client-4', 'Delta', null, 10, false)]);

  return [rootA, rootB];
}

describe('client row construction', () => {
  it('emits clients in recursive pre-order without reversing siblings', () => {
    const rows = buildClientRows(fixtureRoots());

    expect(rows.map((row) => `${row.node.id}:${row.client.mac}`)).toEqual([
      'root-a:client-1',
      'root-a:client-2',
      'child-a:client-3',
      'root-b:client-4',
    ]);
  });
});

describe('client row filtering', () => {
  it.each([
    ['name', 'alpha'],
    ['ip', '10.0.0.10'],
    ['mac', 'CLIENT-3'],
    ['node', 'child-a'],
  ])('matches case-insensitively by %s', (_field, query) => {
    const rows = buildClientRows(fixtureRoots());

    expect(filterRows(rows, query)).toHaveLength(1);
  });

  it('returns all rows for an empty or whitespace query', () => {
    const rows = buildClientRows(fixtureRoots());

    expect(filterRows(rows, '')).toEqual(rows);
    expect(filterRows(rows, '   ')).toEqual(rows);
  });
});

describe('client row sorting', () => {
  const rows = buildClientRows(fixtureRoots());

  it('sorts names and node names in both directions', () => {
    expect(sortRows(rows, 'name', 'asc').map((row) => row.client.name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);
    expect(sortRows(rows, 'node', 'desc').map((row) => row.node.name)).toEqual([
      'Root-B',
      'Root-A',
      'Root-A',
      'Child-A',
    ]);
  });

  it('sorts links with wired first in ascending order and wireless first in descending order', () => {
    expect(sortRows(rows, 'link', 'asc').map((row) => row.client.wired)).toEqual([true, true, false, false]);
    expect(sortRows(rows, 'link', 'desc').map((row) => row.client.wired)).toEqual([false, false, true, true]);
  });

  it('sorts IP addresses numerically by octet and keeps null last', () => {
    expect(sortRows(rows, 'ip', 'asc').map((row) => row.client.ip)).toEqual([
      '10.0.0.2',
      '10.0.0.3',
      '10.0.0.10',
      null,
    ]);
    expect(sortRows(rows, 'ip', 'desc').map((row) => row.client.ip)).toEqual([
      '10.0.0.10',
      '10.0.0.3',
      '10.0.0.2',
      null,
    ]);

    const invalidRows = buildClientRows([
      node('invalid', 'Invalid', [client('invalid-client', 'Invalid', 'not-an-ip', 1, false)]),
      node('null', 'Null', [client('null-client', 'Null', null, 2, false)]),
    ]);

    expect(sortRows(invalidRows, 'ip', 'asc').map((row) => row.client.ip)).toEqual(['not-an-ip', null]);
  });

  it('sorts uptime numerically and keeps null last in both directions', () => {
    expect(sortRows(rows, 'uptime', 'asc').map((row) => row.client.uptime)).toEqual([10, 20, 30, null]);
    expect(sortRows(rows, 'uptime', 'desc').map((row) => row.client.uptime)).toEqual([30, 20, 10, null]);
  });

  it('sorts MAC addresses case-insensitively in both directions', () => {
    expect(sortRows(rows, 'mac', 'asc').map((row) => row.client.mac)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
    ]);
    expect(sortRows(rows, 'mac', 'desc').map((row) => row.client.mac)).toEqual([
      'client-4',
      'client-3',
      'client-2',
      'client-1',
    ]);
  });

  it('preserves source order for equal sort keys', () => {
    const equalRows = buildClientRows([
      node('root', 'Root', [
        client('a', 'Same', '192.168.1.1', 1, true),
        client('b', 'Same', '192.168.1.2', 2, false),
      ]),
    ]);

    expect(sortRows(equalRows, 'name', 'asc')).toEqual(equalRows);
  });
});
