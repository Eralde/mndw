import {describe, expect, it} from 'vitest';
import {normalizeDeviceHosts, normalizeMembers} from '../../api/normalize';
import type {MwsMemberRecord} from '../../api/rci.types';
import {loadFixture} from '../../fixtures/load';
import type {ControllerInfo} from './mws.types';
import {buildMap, findNodeById} from './map-builder';

const CONTROLLER: ControllerInfo = {
  mac: '02:7d:4a:91:c3:10',
  ip: '192.168.1.1',
  name: 'My Router',
  model: 'Hopper (KN-3811)',
  firmware: '5.2 Alpha 1',
  interfaceUptime: 3201,
  isOnline: true,
};

function fixtureMembers(): MwsMemberRecord[] {
  return normalizeMembers(loadFixture('show-mws-member.json'));
}

function member(overrides: Partial<MwsMemberRecord> & {cid: string; mac: string}): MwsMemberRecord {
  return {
    model: null,
    knownHost: null,
    ip: null,
    fw: null,
    fwAvailable: null,
    system: null,
    backhaul: null,
    ...overrides,
  };
}

function backhaulTo(parentMac: string, ap: string | null = null): MwsMemberRecord['backhaul'] {
  return {
    uplink: null,
    bridge: `8000.${parentMac}`,
    parentMac,
    ap,
    rssi: null,
    txrate: null,
    mode: null,
    security: null,
    cost: null,
    speed: null,
    duplex: null,
    portLabel: null,
  };
}

describe('buildMap — topology', () => {
  it('builds the captured two-member chain rooted at the controller', () => {
    const roots = buildMap(fixtureMembers(), [], CONTROLLER);

    expect(roots).toHaveLength(1);

    const controller = roots[0];

    expect(controller.isController).toBe(true);
    expect(controller.id).toBe('02:7d:4a:91:c3:10');
    expect(controller.name).toBe('My Router');
    expect(controller.fwAvailable).toBeNull();
    expect(controller.system).toEqual({cpuload: null, memoryUsed: null, memoryTotal: null, uptime: 3201});
    expect(controller.children).toHaveLength(1);

    const buddy = controller.children[0].node;

    expect(controller.children[0].type).toBe('wireless');
    expect(buddy.id).toBe('02:7d:4a:91:c3:21');
    expect(buddy.isOnline).toBe(true);
    expect(buddy.children).toHaveLength(1);
    expect(buddy.children[0].type).toBe('wired');
    expect(buddy.children[0].node.id).toBe('02:7d:4a:91:c3:32');
    expect(buddy.children[0].node.parent?.node).toBe(buddy);
  });

  it('makes an offline member (no backhaul) a detached root with isOnline false', () => {
    const roots = buildMap([member({cid: 'c1', mac: 'aa:00:00:00:00:01'})], [], CONTROLLER);

    expect(roots).toHaveLength(2);
    expect(roots[1].isOnline).toBe(false);
    expect(roots[1].parent).toBeNull();
  });

  it('makes a member with an unresolvable parent MAC a detached root', () => {
    const roots = buildMap(
      [member({cid: 'c1', mac: 'aa:00:00:00:00:01', backhaul: backhaulTo('99:99:99:99:99:99')})],
      [],
      CONTROLLER,
    );

    expect(roots).toHaveLength(2);
    expect(roots[1].isOnline).toBe(true);
    expect(roots[1].parent).toBeNull();
  });

  it('keeps the first record for duplicate member MACs', () => {
    const roots = buildMap(
      [
        member({cid: 'c1', mac: 'aa:00:00:00:00:01', knownHost: 'first'}),
        member({cid: 'c2', mac: 'aa:00:00:00:00:01', knownHost: 'second'}),
      ],
      [],
      CONTROLLER,
    );

    expect(roots).toHaveLength(2);
    expect(roots[1].name).toBe('first');
  });

  it('detaches every member of a parent cycle while children outside keep their edges', () => {
    const a = member({cid: 'ca', mac: 'aa:00:00:00:00:0a', backhaul: backhaulTo('aa:00:00:00:00:0b')});
    const b = member({cid: 'cb', mac: 'aa:00:00:00:00:0b', backhaul: backhaulTo('aa:00:00:00:00:0a')});
    const child = member({cid: 'cc', mac: 'aa:00:00:00:00:0c', backhaul: backhaulTo('aa:00:00:00:00:0a')});
    const roots = buildMap([a, b, child], [], CONTROLLER);
    const nodeA = findNodeById(roots, 'aa:00:00:00:00:0a');
    const nodeB = findNodeById(roots, 'aa:00:00:00:00:0b');
    const nodeChild = findNodeById(roots, 'aa:00:00:00:00:0c');

    expect(nodeA?.parent).toBeNull();
    expect(nodeB?.parent).toBeNull();
    expect(roots).toContain(nodeA);
    expect(roots).toContain(nodeB);
    expect(nodeChild?.parent?.node).toBe(nodeA);
  });

  it('produces a controller-only forest for an empty member list', () => {
    const roots = buildMap([], [], CONTROLLER);

    expect(roots).toHaveLength(1);
    expect(roots[0].isController).toBe(true);
  });
});

describe('buildMap — client attribution', () => {
  it('attributes fixture clients: no mws object → controller', () => {
    const roots = buildMap(fixtureMembers(), normalizeDeviceHosts(loadFixture('show-device-list.json')), CONTROLLER);

    expect(roots[0].clients).toHaveLength(1);
    expect(roots[0].clients[0].name).toContain('Client A');
  });

  it('attributes a client with a member cid to that member', () => {
    const hosts = normalizeDeviceHosts({
      host: [{mac: 'aa:00:00:00:00:99', active: true, name: 'cam', mws: {cid: '1a2c405a-fabb-11ee-911a-2559b061cca4'}}],
    });
    const roots = buildMap(fixtureMembers(), hosts, CONTROLLER);
    const buddy = findNodeById(roots, '02:7d:4a:91:c3:21');

    expect(buddy?.clients).toHaveLength(1);
    expect(buddy?.clients[0].name).toBe('cam');
  });

  it('attributes unmatched and ambiguous cids to the controller', () => {
    const dupA = member({cid: 'dup', mac: 'aa:00:00:00:00:01', backhaul: backhaulTo(CONTROLLER.mac)});
    const dupB = member({cid: 'dup', mac: 'aa:00:00:00:00:02', backhaul: backhaulTo(CONTROLLER.mac)});
    const hosts = normalizeDeviceHosts({
      host: [
        {mac: 'aa:00:00:00:00:98', active: true, name: 'ambiguous', mws: {cid: 'dup'}},
        {mac: 'aa:00:00:00:00:97', active: true, name: 'unknown', mws: {cid: 'no-such-cid'}},
      ],
    });
    const roots = buildMap([dupA, dupB], hosts, CONTROLLER);

    expect(roots[0].clients.map((client) => client.name).sort()).toEqual(['ambiguous', 'unknown']);
  });
});

describe('findNodeById', () => {
  it('finds nodes anywhere in the forest and returns null for misses', () => {
    const roots = buildMap(fixtureMembers(), [], CONTROLLER);

    expect(findNodeById(roots, '02:7d:4a:91:c3:32')?.model).toBe('Atlas SE (KN-4310)');
    expect(findNodeById(roots, 'no:pe')).toBeNull();
  });
});
