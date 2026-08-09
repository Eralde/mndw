import {describe, expect, it} from 'vitest';
import type {MwsNode} from '../../domain/mws/mws.types';
import {edgeTooltip, edgeType, linkQuality} from './link-quality';

function node(backhaul: MwsNode['backhaul']): MwsNode {
  return {
    id: 'node',
    cid: null,
    name: 'Node',
    model: null,
    ip: null,
    mac: 'node',
    isController: false,
    isOnline: backhaul !== null,
    fw: null,
    fwAvailable: null,
    system: null,
    backhaul,
    parent: null,
    children: [],
    clients: [],
    dualBand: false,
  };
}

describe('link quality', () => {
  it('classifies wireless RSSI bands and boundaries', () => {
    expect(linkQuality(node({ap: 'ap', rssi: -55} as MwsNode['backhaul']))).toBe('good');
    expect(linkQuality(node({ap: 'ap', rssi: -70} as MwsNode['backhaul']))).toBe('fair');
    expect(linkQuality(node({ap: 'ap', rssi: -71} as MwsNode['backhaul']))).toBe('weak');
  });

  it('classifies wired speed and invalid values', () => {
    expect(linkQuality(node({ap: null, speed: '1000'} as MwsNode['backhaul']))).toBe('good');
    expect(linkQuality(node({ap: null, speed: '100'} as MwsNode['backhaul']))).toBe('fair');
    expect(linkQuality(node({ap: null, speed: '99'} as MwsNode['backhaul']))).toBe('weak');
    expect(linkQuality(node({ap: null, speed: '0'} as MwsNode['backhaul']))).toBe('unknown');
    expect(linkQuality(node(null))).toBe('unknown');
  });

  it('derives edge type and omits unreadable tooltip segments', () => {
    const wireless = node({ap: 'ap', rssi: -35, txrate: 1201, mode: '11ax'} as MwsNode['backhaul']);
    const wired = node({ap: null, speed: '1000', duplex: 'full'} as MwsNode['backhaul']);

    expect(edgeType(wireless)).toBe('wireless');
    expect(edgeType(wired)).toBe('wired');
    expect(edgeTooltip(wireless)).toBe('Wireless · −35 dBm · 1.2 Gbit/s · 11ax');
    expect(edgeTooltip(wired)).toBe('Wired · 1 Gbit/s · full duplex');
    expect(edgeTooltip(node({ap: 'ap', rssi: null, txrate: null, mode: null} as MwsNode['backhaul']))).toBe('Wireless');
  });
});
