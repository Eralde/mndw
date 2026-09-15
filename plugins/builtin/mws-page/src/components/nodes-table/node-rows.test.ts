import {describe, expect, it} from 'vitest';
import type {MwsNode} from '../../domain/mws/mws.types';
import {buildNodeRows, filterNodeRows, reconcileNodeRows, sortNodeRows} from './node-rows';

function node(
  id: string,
  name: string,
  options: {
    clients?: number;
    uptime?: number | null;
    ip?: string | null;
    firmware?: string | null;
    firmwareAvailable?: string | null;
    online?: boolean;
    children?: MwsNode[];
  } = {},
): MwsNode {
  return {
    id,
    cid: null,
    name,
    model: null,
    ip: options.ip ?? null,
    mac: id,
    isController: false,
    isOnline: options.online ?? true,
    fw: options.firmware ?? null,
    fwAvailable: options.firmwareAvailable ?? null,
    system: options.uptime === undefined ? null : {
      cpuload: null,
      memoryUsed: null,
      memoryTotal: null,
      uptime: options.uptime,
    },
    backhaul: null,
    parent: null,
    children: (options.children ?? []).map((child) => ({type: 'wired', node: child})),
    clients: Array.from({length: options.clients ?? 0}, (_, index) => ({
      mac: `${id}-${index}`,
      name: `Client ${index}`,
      ip: null,
      uptime: null,
      lastSeen: null,
      wired: false,
    })),
  };
}

describe('node row construction and filtering', () => {
  it('flattens controller and nested extender nodes in source order', () => {
    const nested = node('nested', 'Nested');
    const extender = node('extender', 'Extender', {children: [nested]});
    const controller = node('controller', 'Controller', {children: [extender]});

    expect(buildNodeRows([controller]).map((row) => row.id)).toEqual([
      'controller',
      'extender',
      'nested',
    ]);
  });

  it('filters by node name only and treats whitespace as no filter', () => {
    const rows = buildNodeRows([
      node('alpha', 'Alpha', {ip: '10.0.0.1'}),
      node('beta', 'Beta', {ip: '10.0.0.2'}),
    ]);

    expect(filterNodeRows(rows, 'ALP').map((row) => row.id)).toEqual(['alpha']);
    expect(filterNodeRows(rows, '10.0.0.2')).toEqual([]);
    expect(filterNodeRows(rows, '   ')).toEqual(rows);
  });
});

describe('node row sorting', () => {
  const rows = buildNodeRows([
    node('beta', 'beta', {clients: 2, uptime: 20, ip: '10.0.0.10', firmware: '5.2'}),
    node('alpha', 'Alpha', {clients: 10, uptime: null, ip: '10.0.0.2', firmware: '5.10'}),
    node('gamma', 'Gamma', {clients: 1, uptime: 5, ip: null, firmware: null}),
  ]);

  it('sorts text and numeric keys with nulls last in both directions', () => {
    expect(sortNodeRows(rows, 'name', 'asc').map((row) => row.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortNodeRows(rows, 'name', 'desc').map((row) => row.id)).toEqual(['gamma', 'beta', 'alpha']);
    expect(sortNodeRows(rows, 'clients', 'desc').map((row) => row.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortNodeRows(rows, 'uptime', 'asc').map((row) => row.id)).toEqual(['gamma', 'beta', 'alpha']);
    expect(sortNodeRows(rows, 'uptime', 'desc').map((row) => row.id)).toEqual(['beta', 'gamma', 'alpha']);
  });

  it('sorts IPv4 addresses numerically and keeps invalid values last', () => {
    const invalid = buildNodeRows([
      node('invalid', 'Invalid', {ip: 'not-an-ip'}),
      node('valid', 'Valid', {ip: '10.0.0.3'}),
    ]);

    expect(sortNodeRows(rows, 'ip', 'asc').map((row) => row.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortNodeRows(invalid, 'ip', 'asc').map((row) => row.id)).toEqual(['valid', 'invalid']);
  });

  it('preserves source order for equal values', () => {
    const equal = buildNodeRows([node('first', 'Same'), node('second', 'Same')]);

    expect(sortNodeRows(equal, 'name', 'asc').map((row) => row.id)).toEqual(['first', 'second']);
  });
});

describe('node polling projection', () => {
  it('updates values by ID while preserving order and appending new visible IDs', () => {
    const previous = buildNodeRows([
      node('first', 'Alpha', {clients: 1}),
      node('second', 'Beta', {clients: 2}),
    ]);
    const next = buildNodeRows([
      node('first', 'Zulu', {clients: 9}),
      node('second', 'Beta', {clients: 3}),
      node('new', 'Aaron', {clients: 4}),
    ]);

    const projected = reconcileNodeRows(previous, next, '');

    expect(projected.map((row) => row.id)).toEqual(['first', 'second', 'new']);
    expect(projected[0]?.node.name).toBe('Zulu');
    expect(projected[0]?.node.clients).toHaveLength(9);
  });

  it('removes missing rows and applies current filter membership without re-sorting', () => {
    const previous = buildNodeRows([
      node('first', 'Alpha'),
      node('second', 'Beta'),
      node('third', 'Gamma'),
    ]);
    const next = buildNodeRows([
      node('first', 'Alpha'),
      node('third', 'Aaron'),
    ]);

    expect(reconcileNodeRows(previous, next, 'a').map((row) => row.id)).toEqual(['first', 'third']);
  });
});
