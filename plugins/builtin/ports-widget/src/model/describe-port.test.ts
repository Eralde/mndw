import {expect, it} from 'vitest';
import type {Switchport} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import messages from '../../i18n/en.json';
import type {LinkInfo} from '../rci/parse-interface.js';
import {describePort} from './describe-port.js';

const en = createTestI18n(messages);

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

function link(overrides: Partial<LinkInfo> = {}): LinkInfo {
  return {
    status: 'up',
    speedMbps: 100,
    duplex: 'full',
    autoNegotiation: true,
    flowControl: true,
    eee: false,
    lastChangeSeconds: 1,
    hasSfp: false,
    ...overrides,
  };
}

it('names every visible state of a slow link-up port', () => {
  expect(describePort(port, link(), 1000, en)).toBe(
    'Port 4, LAN: link up, 100 Mbps full duplex, slower than the 1 Gbps maximum',
  );
});

it('includes the description in the focusable port name', () => {
  expect(describePort(port, link(), 1000, en, 'Office uplink')).toBe(
    'Port 4, LAN: Office uplink, link up, 100 Mbps full duplex, slower than the 1 Gbps maximum',
  );
});

it('names a down port without speed details', () => {
  expect(describePort(port, link({status: 'down', speedMbps: null, duplex: null}), 1000, en)).toBe(
    'Port 4, LAN: link down',
  );
});

it('names the duplex of a half-duplex link', () => {
  expect(describePort(port, link({duplex: 'half'}), 100, en)).toBe(
    'Port 4, LAN: link up, 100 Mbps half duplex, half-duplex warning',
  );
});
