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
      isReversed: true,
      isCombo: true,
      isComboInverted: true,
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
    expect(result.switchports.list[0]?.isReversed).toBe(true);
    expect(result.switchports.list[0]?.isCombo).toBe(true);
    expect(result.switchports.list[0]?.isComboInverted).toBe(true);
  });

  it('defaults combo flags to false for legacy daemon replies', () => {
    const {isCombo: _isCombo, isComboInverted: _isComboInverted, ...legacyPort} = validPayload.switchports.list[0];
    const result = decodeDeviceHardware({
      ...validPayload,
      switchports: {...validPayload.switchports, list: [legacyPort]},
    });

    expect(result.switchports.list[0]?.isCombo).toBe(false);
    expect(result.switchports.list[0]?.isComboInverted).toBe(false);
  });

  it('rejects a non-boolean isReversed value', () => {
    expect(() =>
      decodeDeviceHardware({
        ...validPayload,
        switchports: {
          ...validPayload.switchports,
          list: [{...validPayload.switchports.list[0], isReversed: 'true'}],
        },
      })
    ).toThrow();
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
