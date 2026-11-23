import {expect, it} from 'vitest';
import type {Switchport} from '@mndw/sdk';
import {CAPABILITIES_PATH, LINK_PATH, STAT_PATH, capabilitiesQuery, linkQuery, statQuery} from './queries.js';

const port: Switchport = {
  id: 'LAN4',
  label: '4',
  index: 4,
  type: 'ethernet',
  group: 'LAN',
  color: 'gray',
  interfaceId: 'GigabitEthernet0/3',
  isReversed: true,
};

it('addresses every request by the interface id', () => {
  expect(linkQuery(port)).toEqual({path: LINK_PATH, data: {name: 'GigabitEthernet0/3'}});
  expect(statQuery(port)).toEqual({path: STAT_PATH, data: {name: 'GigabitEthernet0/3'}});
  expect(capabilitiesQuery(port)).toEqual({path: CAPABILITIES_PATH, data: {name: 'GigabitEthernet0/3'}});
  expect([LINK_PATH, STAT_PATH, CAPABILITIES_PATH]).toEqual([
    'show.interface',
    'show.interface.stat',
    'show.interface.ethernet.capabilities',
  ]);
});
