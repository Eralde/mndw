import type {DeviceInfoData} from '@mndw/sdk';
import {describe, expect, it} from 'vitest';
import {createDeviceInfoContext} from './device-info-context.js';

const snapshot: DeviceInfoData = {
  deviceName: 'Hopper',
  vendor: 'Keenetic',
  manufacturer: 'Keenetic',
  model: 'KN-3810',
  series: 'Hopper',
  region: 'WW',
  hwId: 'hopper',
  hwVersion: '1.0',
  hwType: 'router',
  firmwareVersion: '4.2.1',
  firmwareRelease: '4.2.1',
  architecture: 'mips',
  features: ['WiFi', 'USB'],
  components: ['easyconfig'],
  switchports: {
    list: [{
      id: 'WAN',
      label: '0',
      index: 0,
      type: 'ethernet',
      group: 'WAN',
      color: 'blue',
      interfaceId: 'GigabitEthernet1/0',
    }],
    layout: [['0'], ['1']],
    hasPortStats: true,
  },
  usb: {ports: ['usb3']},
};

describe('createDeviceInfoContext', () => {
  it('creates independent frozen snapshots with capability helpers', () => {
    const first = createDeviceInfoContext(snapshot);
    const second = createDeviceInfoContext(snapshot);

    expect(first).not.toBe(second);
    expect(first).not.toHaveProperty('class');
    expect(first.switchports).not.toBe(second.switchports);
    expect(first.usb).not.toBe(second.usb);
    expect(first.hasFeature('wifi')).toBe(true);
    expect(first.hasComponent('EASYCONFIG')).toBe(true);
    expect(first.hasFeature(' WiFi ')).toBe(false);
    expect(first.hasFeature('missing')).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.switchports)).toBe(true);
    expect(Object.isFrozen(first.switchports.list)).toBe(true);
    expect(Object.isFrozen(first.switchports.list[0])).toBe(true);
    expect(Object.isFrozen(first.switchports.layout)).toBe(true);
    expect(Object.isFrozen(first.switchports.layout[0])).toBe(true);
    expect(Object.isFrozen(first.usb)).toBe(true);
    expect(Object.isFrozen(first.usb.ports)).toBe(true);
    expect(Object.isFrozen(first.features)).toBe(true);
    expect(Object.isFrozen(first.components)).toBe(true);

    const firstPort = first.switchports.list.at(0);

    if (firstPort === undefined) {
      throw new Error('expected fixture port');
    }

    expect(() =>
      (first.switchports.list as typeof first.switchports.list & {push: (port: typeof firstPort) => number}).push(
        firstPort,
      )
    ).toThrow();
  });
});
