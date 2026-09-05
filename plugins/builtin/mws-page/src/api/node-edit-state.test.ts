import {describe, expect, it} from 'vitest';
import {normalizeBridgeSegments, parseNodeEditState} from './node-edit-state';

describe('parseNodeEditState', () => {
  it('reads static IP, update channel, and native port roles for a member', () => {
    expect(parseNodeEditState(
      {host: [{mac: '02:7d:4a:91:c3:21', ip: '192.168.1.100'}]},
      {
        '02:7d:4a:91:c3:21': {
          update: {channel: 'stable'},
          port: {
            0: {disable: true},
            1: {access: {interface: 'Bridge1'}},
          },
        },
      },
      '02:7d:4a:91:c3:21',
    )).toEqual({
      staticIpEnabled: true,
      staticIp: '192.168.1.100',
      updateChannel: 'stable',
      portRoles: [
        {port: 0, role: 'disabled'},
        {port: 1, role: {segment: 'Bridge1'}},
      ],
    });
  });

  it('uses native defaults when no overrides exist', () => {
    expect(parseNodeEditState({}, {}, '02:7d:4a:91:c3:21')).toEqual({
      staticIpEnabled: false,
      staticIp: null,
      updateChannel: null,
      portRoles: [],
    });
  });

  it('parses the real member-list array and treats Bridge0 as Primary', () => {
    const state = parseNodeEditState(
      [],
      [{member: '50:ff:20:95:26:a6', port: [
        {port: '0', access: {interface: 'Bridge0'}, disable: false},
        {port: '1', access: {interface: 'Bridge1'}, disable: false},
        {port: '2', disable: true},
      ]}],
      '50:ff:20:95:26:a6',
    );

    expect(state.portRoles).toEqual([
      {port: 0, role: 'primary'},
      {port: 1, role: {segment: 'Bridge1'}},
      {port: 2, role: 'disabled'},
    ]);
  });

  it('accepts direct host and member records with object-shaped disable', () => {
    expect(parseNodeEditState(
      {host: {mac: '02:7d:4a:91:c3:21', ip: '192.168.1.100'}},
      {member: {member: '02:7d:4a:91:c3:21', port: {0: {disable: {}}}}},
      '02:7d:4a:91:c3:21',
    )).toEqual({
      staticIpEnabled: true,
      staticIp: '192.168.1.100',
      updateChannel: null,
      portRoles: [{port: 0, role: 'disabled'}],
    });
  });

  it('merges iseg interface configuration with bridge show metadata', () => {
    expect(normalizeBridgeSegments(
      {
        Bridge0: {iseg: {include: 'WifiMaster0/AccessPoint0'}},
        Guest: {iseg: {include: 'WifiMaster0/AccessPoint1'}},
        IoT: {iseg: {include: 'WifiMaster0/AccessPoint2'}},
        WifiMaster0: {iseg: {}},
        Missing: {iseg: {}},
      },
      {
        Bridge0: {id: 'Bridge0', type: 'Bridge', description: 'Home'},
        Guest: {id: 'Guest', type: 'Bridge', description: 'Guest'},
        IoT: {id: 'IoT', type: 'Bridge'},
        WifiMaster0: {id: 'WifiMaster0', type: 'WifiMaster', description: 'Wi-Fi'},
        Other: {id: 'Other', type: 'Bridge', description: 'Not configured'},
      },
    )).toEqual([
      {id: 'Bridge0', label: 'Home'},
      {id: 'Guest', label: 'Guest'},
      {id: 'IoT', label: 'IoT'},
    ]);
  });
});
