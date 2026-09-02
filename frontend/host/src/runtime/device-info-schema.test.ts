import {describe, expect, it} from 'vitest';
import {decodeDeviceHardware, emptySwitchports} from './device-info-schema.js';

const validPayload = {
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
    layout: [['0']],
    hasPortStats: true,
  },
  usbPortCount: 2,
};

describe('decodeDeviceHardware', () => {
  it('decodes switchports and usb port count', () => {
    const result = decodeDeviceHardware(validPayload);

    expect(result.usbPortCount).toBe(2);
    expect(result.switchports.list).toHaveLength(1);
    expect(result.switchports.hasPortStats).toBe(true);
  });

  it('returns an empty switchports value', () => {
    expect(emptySwitchports()).toEqual({list: [], layout: [], hasPortStats: false});
  });

  it('rejects missing required fields', () => {
    expect(() => decodeDeviceHardware({...validPayload, switchports: {...validPayload.switchports, list: undefined}}))
      .toThrow();
    expect(() => decodeDeviceHardware({...validPayload, usbPortCount: '2'})).toThrow();
  });

  it('ignores unknown fields', () => {
    const decoded = decodeDeviceHardware({
      ...validPayload,
      extra: true,
      switchports: {
        ...validPayload.switchports,
        extra: 'ignored',
        list: [{...validPayload.switchports.list[0], extra: 'ignored'}],
      },
    });

    expect(decoded).toEqual(validPayload);
  });
});
