import {expect, it} from 'vitest';
import hotspotReply from '../fixtures/show-ip-hotspot.KN-4310.sanitized.json';
import rcInterfaceReply from '../fixtures/show-rc-interface.KN-4310.sanitized.json';
import {parseHotspotDevices, parsePortDescriptions} from './parse-port-data.js';

it('reads and trims descriptions keyed by interface id', () => {
  expect(parsePortDescriptions({
    GigabitEthernet0: {description: '  Office uplink  '},
    GigabitEthernet1: {description: ''},
    GigabitEthernet2: {description: {no: true}},
  })).toEqual({GigabitEthernet0: 'Office uplink'});
});

it('reads descriptions from the sanitized router configuration sample', () => {
  const descriptions = parsePortDescriptions(rcInterfaceReply);

  expect(descriptions['GigabitEthernet0/Vlan1']).toBe('Home VLAN');
  expect(descriptions.GigabitEthernet1).toBe('Broadband connection');
});

it('maps active wired and Mesh hotspot entries by physical port label', () => {
  expect(parseHotspotDevices({
    host: [
      {active: true, port: '2', name: 'Work laptop', hostname: 'work', mac: 'aa'},
      {active: true, mws: {port: '2'}, hostname: 'Mesh-6', mac: 'bb'},
      {active: true, port: '3', mac: 'cc'},
      {active: false, port: '2', name: 'offline'},
      {port: '2', name: 'not active'},
    ],
  })).toEqual({2: ['Work laptop', 'Mesh-6'], 3: ['cc']});
});

it('maps active wired and Mesh hosts from the sanitized router hotspot sample', () => {
  expect(parseHotspotDevices(hotspotReply)).toEqual({2: ['Work laptop', 'Buddy-6']});
});

it('ignores malformed hotspot data', () => {
  expect(parseHotspotDevices({host: 'bad'})).toEqual({});
  expect(parsePortDescriptions(null)).toEqual({});
});
