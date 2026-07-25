import {describe, expect, it} from 'vitest';
import {buildMap, findNodeById} from '../domain/mws/map-builder';
import {createLargeMockSnapshot} from './large-mock-data';

describe('createLargeMockSnapshot', () => {
  it('generates the requested topology and clients', () => {
    const snapshot = createLargeMockSnapshot(8, 12);
    const roots = buildMap(snapshot.members, snapshot.hosts, {
      mac: snapshot.bridge.mac,
      ip: snapshot.bridge.address,
      name: 'Router',
      model: snapshot.version.model,
      firmware: snapshot.version.firmware,
      interfaceUptime: snapshot.bridge.uptime,
      isOnline: snapshot.bridge.isOnline,
    });
    const nodes = snapshot.members.map((member) => findNodeById(roots, member.mac));

    expect(snapshot.members).toHaveLength(8);
    expect(snapshot.hosts).toHaveLength(12);
    expect(roots).toHaveLength(1);
    expect(nodes.every((node) => node !== null)).toBe(true);
    expect(nodes.some((node) => node?.parent?.type === 'wired')).toBe(true);
    expect(nodes.some((node) => node?.parent?.type === 'wireless')).toBe(true);
    expect(roots[0].clients.length).toBeGreaterThan(0);
    expect(nodes.reduce((count, node) => count + (node?.clients.length ?? 0), roots[0].clients.length)).toBe(12);
  });

  it('distributes clients across requested extender count deterministically', () => {
    const first = createLargeMockSnapshot(4, 20);
    const second = createLargeMockSnapshot(4, 20);

    expect(first).toEqual(second);
    expect(new Set(first.hosts.map((host) => host.mwsCid).filter((cid) => cid !== null)).size).toBe(4);
  });

  it('supports zero extenders and zero clients', () => {
    const snapshot = createLargeMockSnapshot(0, 0);

    expect(snapshot.members).toEqual([]);
    expect(snapshot.hosts).toEqual([]);
  });
});
