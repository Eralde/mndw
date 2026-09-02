import {beforeEach, describe, expect, it, vi} from 'vitest';
import {of, throwError} from 'rxjs';
import type {MgmtClient} from './mgmt-client.js';

vi.mock('./rci/show-version/index.js', () => ({getShowVersion: vi.fn()}));

import {getShowVersion} from './rci/show-version/index.js';
import {fetchDeviceInfo, fetchHostInfo} from './host-info.service.js';

const switchports = {
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
  hasPortStats: false,
};

const showVersion = {
  release: '4.2.1',
  title: '4.2.1',
  arch: 'mips',
  ndm: {exact: '1', cdate: 'today'},
  bsp: {exact: '1', cdate: 'today'},
  ndw: {features: ' wifi, usb_3 ', components: 'easyconfig'},
  manufacturer: 'Keenetic',
  vendor: 'Keenetic',
  series: 'Hopper',
  model: 'KN-3810',
  hw_version: '1.0',
  hw_id: 'hopper',
  device: 'Hopper',
  region: 'WW',
  description: 'Hopper',
};

function managementClient(result: typeof switchports, usbPortCount = 2): Pick<MgmtClient, 'getDeviceHardware'> {
  return {getDeviceHardware: vi.fn().mockResolvedValue({switchports: result, usbPortCount})};
}

describe('fetchHostInfo', () => {
  it('returns only current UI session fields without querying show.version', async () => {
    vi.mocked(getShowVersion).mockClear();

    await expect(fetchHostInfo()).resolves.toEqual({locale: expect.any(String), theme: expect.any(String)});
    expect(getShowVersion).not.toHaveBeenCalled();
  });
});

describe('fetchDeviceInfo', () => {
  beforeEach(() => {
    vi.mocked(getShowVersion).mockReturnValue(of(showVersion));
  });

  it('composes identity, parsed capabilities, switchports, and derived USB ports', async () => {
    const result = await fetchDeviceInfo(managementClient(switchports));

    expect(result).toEqual(expect.objectContaining({
      deviceName: 'Hopper',
      vendor: 'Keenetic',
      firmwareVersion: '4.2.1',
      firmwareRelease: '4.2.1',
      architecture: 'mips',
      features: ['wifi', 'usb_3'],
      components: ['easyconfig'],
      switchports,
      usb: {ports: ['usb2', 'usb3']},
    }));
    expect(result).not.toHaveProperty('ports');
  });

  it('keeps valid hardware when show.version fails', async () => {
    vi.mocked(getShowVersion).mockReturnValue(throwError(() => new Error('rci down')));

    const result = await fetchDeviceInfo(managementClient(switchports));

    expect(result.deviceName).toBe('Unknown');
    expect(result.architecture).toBeUndefined();
    expect(result.features).toEqual([]);
    expect(result.switchports).toBe(switchports);
    expect(result.usb).toEqual({ports: ['usb2', 'usb2']});
  });

  it('keeps version fields when the hardware read fails', async () => {
    const client = {getDeviceHardware: vi.fn().mockRejectedValue(new Error('daemon down'))};

    const result = await fetchDeviceInfo(client);

    expect(result.deviceName).toBe('Hopper');
    expect(result.switchports).toEqual({list: [], layout: [], hasPortStats: false});
    expect(result.usb).toEqual({ports: []});
  });

  it('always resolves with complete fallback data when both reads fail', async () => {
    vi.mocked(getShowVersion).mockReturnValue(throwError(() => new Error('rci down')));

    const client = {getDeviceHardware: vi.fn().mockRejectedValue(new Error('daemon down'))};

    await expect(fetchDeviceInfo(client)).resolves.toEqual(expect.objectContaining({
      deviceName: 'Unknown',
      vendor: 'Unknown',
      manufacturer: 'Unknown',
      model: 'Unknown',
      series: 'Unknown',
      region: 'Unknown',
      hwId: 'Unknown',
      hwVersion: 'Unknown',
      firmwareVersion: 'Unknown',
      firmwareRelease: 'Unknown',
      features: [],
      components: [],
      switchports: {list: [], layout: [], hasPortStats: false},
      usb: {ports: []},
    }));
  });
});
