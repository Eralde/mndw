import {describe, expect, it} from 'vitest';
import {loadFixture} from '../fixtures/load';
import type {RawDeviceHost, RawMwsMember} from './rci.types';
import {
  MwsApiParseError,
  normalizeBridge,
  normalizeControllerDescription,
  normalizeDeviceHosts,
  normalizeMac,
  normalizeMembers,
  normalizeVersion,
  parentMacFromBridge,
} from './normalize';

const memberFixture = loadFixture<RawMwsMember[]>('show-mws-member.json');
const deviceListFixture = loadFixture<{host: RawDeviceHost[]}>('show-device-list.json');

describe('normalizeMac / parentMacFromBridge', () => {
  it('lowercases and trims MACs', () => {
    expect(normalizeMac(' 02:7D:4A:91:C3:21 ')).toBe('02:7d:4a:91:c3:21');
  });

  it('extracts the MAC suffix from a bridge id', () => {
    expect(parentMacFromBridge('e000.02:7D:4A:91:C3:21')).toBe('02:7d:4a:91:c3:21');
    expect(parentMacFromBridge('8000.02:7d:4a:91:c3:10')).toBe('02:7d:4a:91:c3:10');
  });

  it('returns null when no MAC suffix parses', () => {
    expect(parentMacFromBridge('garbage')).toBeNull();
    expect(parentMacFromBridge('')).toBeNull();
  });
});

describe('normalizeMembers', () => {
  it('normalizes the captured members', () => {
    const members = normalizeMembers(memberFixture);

    expect(members).toHaveLength(2);

    const buddy = members[0];

    expect(buddy.cid).toBe('1a2c405a-fabb-11ee-911a-2559b061cca4');
    expect(buddy.mac).toBe('02:7d:4a:91:c3:21');
    expect(buddy.knownHost).toBe('Mesh Extender A');
    expect(buddy.dualBand).toBe(true);
    expect(buddy.system).toEqual({cpuload: 1, memoryUsed: 171412, memoryTotal: 262144, uptime: 759});
    expect(buddy.backhaul?.parentMac).toBe('02:7d:4a:91:c3:10');
    expect(buddy.backhaul?.ap).toBe('WifiMaster1/Backhaul0');
    expect(buddy.backhaul?.rssi).toBe(-35);
    expect(buddy.hwId).toBe('KN-3411');
    expect(buddy.fwUpdateAvailable).toBe(true);
    expect(buddy.fwUpdateSandboxes).toHaveLength(4);
    expect(buddy.ports).toEqual([
      {index: 0, label: '0', appearance: null, link: 'up', speed: '1000', duplex: 'full'},
    ]);
    expect(buddy.wirelessBands).toEqual(['2.4', '5']);

    const atlas = members[1];

    expect(atlas.backhaul?.parentMac).toBe('02:7d:4a:91:c3:21');
    expect(atlas.backhaul?.ap).toBeNull();
    expect(atlas.backhaul?.speed).toBe('1000');
    expect(atlas.backhaul?.duplex).toBe('full');
    expect(atlas.backhaul?.portLabel).toBe('0');
    expect(atlas.dualBand).toBe(false);
  });

  it('normalizes an empty object as no members', () => {
    expect(normalizeMembers({})).toEqual([]);
  });

  it('normalizes member inventory fields', () => {
    const [member] = normalizeMembers([{
      'cid': 'c1',
      'mac': '02:7d:4a:91:c3:21',
      'hw-id': 'KN-3411',
      'mode': 'extender',
      'region': 'EU',
      'port': [{label: 'Port 0', appearance: 'sfp', link: 'up', speed: '1000', duplex: true}],
      'fw-update-available': true,
      'fw-update-sandboxes': [{version: '5.2.0', name: 'stable'}],
      'wireless': {band: ['2.4', '5']},
    }]);

    expect(member.ports).toEqual([
      {index: 0, label: 'Port 0', appearance: 'sfp', link: 'up', speed: '1000', duplex: 'full'},
    ]);
    expect(member.hwId).toBe('KN-3411');
    expect(member.mode).toBe('extender');
    expect(member.region).toBe('EU');
    expect(member.fwUpdateAvailable).toBe(true);
    expect(member.fwUpdateSandboxes).toEqual([{version: '5.2.0', name: 'stable'}]);
    expect(member.wirelessBands).toEqual(['2.4', '5']);
  });

  it('normalizes device-shaped hw_id and wireless band objects', () => {
    const [member] = normalizeMembers([{
      cid: 'cid-1',
      mac: '02:7d:4a:91:c3:21',
      hw_id: 'KN-3411',
      wireless: {band: [{index: '0'}, {index: '1'}]},
    }]);

    expect(member.hwId).toBe('KN-3411');
    expect(member.wirelessBands).toEqual(['0', '1']);
  });

  it('defaults optional member inventory fields', () => {
    const [member] = normalizeMembers([{cid: 'c1', mac: '02:7d:4a:91:c3:21'}]);

    expect(member.ports).toEqual([]);
    expect(member.hwId).toBeNull();
    expect(member.mode).toBeNull();
    expect(member.region).toBeNull();
    expect(member.fwUpdateAvailable).toBe(false);
    expect(member.fwUpdateSandboxes).toEqual([]);
    expect(member.wirelessBands).toEqual([]);
  });

  it('only treats an exact true dual-band capability as enabled', () => {
    const [trueValue, falseValue, stringValue, numberValue, malformedValue] = normalizeMembers([
      {cid: 'c1', mac: 'aa:00:00:00:00:01', capabilities: {'dual-band': true}},
      {cid: 'c2', mac: 'aa:00:00:00:00:02', capabilities: {'dual-band': false}},
      {cid: 'c3', mac: 'aa:00:00:00:00:03', capabilities: {'dual-band': 'true'}},
      {cid: 'c4', mac: 'aa:00:00:00:00:04', capabilities: {'dual-band': 1}},
      {cid: 'c5', mac: 'aa:00:00:00:00:05', capabilities: null},
    ]);

    expect(trueValue.dualBand).toBe(true);
    expect(falseValue.dualBand).toBe(false);
    expect(stringValue.dualBand).toBe(false);
    expect(numberValue.dualBand).toBe(false);
    expect(malformedValue.dualBand).toBe(false);
  });

  it('treats a missing cid or mac as a parse failure', () => {
    expect(() => normalizeMembers([{mac: '02:7d:4a:91:c3:21'}])).toThrow(MwsApiParseError);
    expect(() => normalizeMembers([{cid: 'x'}])).toThrow(MwsApiParseError);
    expect(() => normalizeMembers({not: 'an array'})).toThrow(MwsApiParseError);
  });

  it('nulls malformed system memory instead of guessing', () => {
    const [member] = normalizeMembers([
      {cid: 'c', mac: 'AA:BB:CC:DD:EE:FF', system: {cpuload: 2, memory: 'weird', uptime: 'NaNish'}},
    ]);

    expect(member.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(member.system).toEqual({cpuload: 2, memoryUsed: null, memoryTotal: null, uptime: null});
  });

  it('rejects malformed required MACs', () => {
    expect(() => normalizeMac('not-a-mac')).toThrow(MwsApiParseError);
  });
});

describe('normalizeDeviceHosts', () => {
  it('keeps only active non-extender, non-backhaul hosts', () => {
    const hosts = normalizeDeviceHosts(deviceListFixture);

    expect(hosts).toHaveLength(1);
    expect(hosts[0].mac).toBe('02:7d:4a:91:c3:43');
    expect(hosts[0].name).toBe('Client A');
    expect(hosts[0].wired).toBe(true);
    expect(hosts[0].mwsCid).toBeNull();
  });

  it('falls back name → hostname → mac', () => {
    const hosts = normalizeDeviceHosts({
      host: [
        {mac: 'AA:00:00:00:00:01', active: true, hostname: 'box'},
        {mac: 'AA:00:00:00:00:02', active: true},
      ],
    });

    expect(hosts[0].name).toBe('box');
    expect(hosts[1].name).toBe('aa:00:00:00:00:02');
  });

  it('marks hosts without a top-level port as wireless', () => {
    const hosts = normalizeDeviceHosts({
      host: [{mac: 'aa:00:00:00:00:03', active: true, mws: {cid: 'some-cid'}}],
    });

    expect(hosts[0].wired).toBe(false);
    expect(hosts[0].mwsCid).toBe('some-cid');
  });

  it('treats a kept host without mac as a parse failure', () => {
    expect(() => normalizeDeviceHosts({host: [{active: true}]})).toThrow(MwsApiParseError);
  });

  it('treats a response without a host array as a parse failure', () => {
    expect(() => normalizeDeviceHosts({})).toThrow(MwsApiParseError);
  });
});

describe('normalizeBridge', () => {
  it('normalizes the captured Bridge0 response', () => {
    const bridge = normalizeBridge(loadFixture('show-interface-bridge0.json'));

    expect(bridge).toEqual({mac: '02:7d:4a:91:c3:10', address: '192.168.1.1', uptime: 3201, isOnline: true});
  });

  it('is offline when neither state, link, nor connected says up', () => {
    expect(normalizeBridge({mac: 'aa:bb:cc:dd:ee:ff', state: 'down'}).isOnline).toBe(false);
  });

  it('requires mac', () => {
    expect(() => normalizeBridge({address: '10.0.0.1'})).toThrow(MwsApiParseError);
  });
});

describe('normalizeVersion', () => {
  it('prefers model and title', () => {
    expect(normalizeVersion(loadFixture('show-version.json'))).toEqual({
      model: 'Hopper (KN-3811)',
      firmware: '5.2 Alpha 1',
    });
  });

  it('falls back to description and release', () => {
    expect(normalizeVersion({description: 'Some device', release: '4.3'})).toEqual({
      model: 'Some device',
      firmware: '4.3',
    });
  });

  it('yields nulls for an empty object', () => {
    expect(normalizeVersion({})).toEqual({model: null, firmware: null});
  });
});

describe('normalizeControllerDescription', () => {
  it('accepts the direct and data-wrapped response forms', () => {
    expect(normalizeControllerDescription('  Router  ')).toBe('Router');
    expect(normalizeControllerDescription({data: '  Router  '})).toBe('Router');
  });

  it('returns null for an empty or unrelated response', () => {
    expect(normalizeControllerDescription({data: ' '})).toBeNull();
    expect(normalizeControllerDescription({status: [{status: 'ok'}]})).toBeNull();
  });
});
