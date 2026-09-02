import {describe, expect, it} from 'vitest';
import {processDeviceUsbInfo} from './device-usb.js';

const featureSet = (...names: string[]) => {
  const set = new Set(names.map((name) => name.toLowerCase()));

  return (name: string): boolean => set.has(name.toLowerCase());
};

describe('processDeviceUsbInfo', () => {
  it('reports no USB ports when the count is zero', () => {
    expect(processDeviceUsbInfo(0, featureSet())).toEqual({ports: []});
  });

  it('marks all ports usb2 without a usb3 feature', () => {
    expect(processDeviceUsbInfo(2, featureSet())).toEqual({ports: ['usb2', 'usb2']});
  });

  it('marks a single port usb3 when usb_3 is present', () => {
    expect(processDeviceUsbInfo(1, featureSet('usb_3'))).toEqual({ports: ['usb3']});
  });

  it('treats usb_3_conf as usb3-capable', () => {
    expect(processDeviceUsbInfo(1, featureSet('usb_3_conf'))).toEqual({ports: ['usb3']});
  });

  it('places usb3 last by default on a two-port device', () => {
    expect(processDeviceUsbInfo(2, featureSet('usb_3'))).toEqual({ports: ['usb2', 'usb3']});
  });

  it('places usb3 first when usb_3_first is present', () => {
    expect(processDeviceUsbInfo(2, featureSet('usb_3', 'usb_3_first'))).toEqual({ports: ['usb3', 'usb2']});
  });

  it('forces the count to one when single_usb_port is present', () => {
    expect(processDeviceUsbInfo(4, featureSet('single_usb_port', 'usb_3'))).toEqual({ports: ['usb3']});
  });
});
