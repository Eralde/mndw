import {describe, expect, it} from 'vitest';
import {
  buildSetNameQueries,
  buildSetPortRoleQueries,
  buildSetStaticIpQueries,
  buildSetUpdateChannelQueries,
} from './mws-rci-write';

describe('mws RCI write builders', () => {
  it('builds name and static-IP writes with save commands', () => {
    expect(buildSetNameQueries('02:7d:4a:91:c3:21', 'Extender')).toEqual([
      {path: 'known.host', data: {mac: '02:7d:4a:91:c3:21', name: 'Extender'}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetNameQueries('02:7d:4a:91:c3:21', '')).toEqual([
      {path: 'known.host', data: {mac: '02:7d:4a:91:c3:21', no: true}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetStaticIpQueries('02:7d:4a:91:c3:21', '192.168.1.100')).toEqual([
      {path: 'ip.dhcp.host', data: {mac: '02:7d:4a:91:c3:21', ip: '192.168.1.100'}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetStaticIpQueries('02:7d:4a:91:c3:21', null)).toEqual([
      {path: 'ip.dhcp.host', data: {mac: '02:7d:4a:91:c3:21', no: true}},
      {path: 'system.configuration.save'},
    ]);
  });

  it('builds update-channel explicit and controller-default writes', () => {
    expect(buildSetUpdateChannelQueries('02:7d:4a:91:c3:21', 'stable')).toEqual([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', update: {channel: 'stable'}}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetUpdateChannelQueries('02:7d:4a:91:c3:21', null)).toEqual([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', update: {channel: {no: true}}}},
      {path: 'system.configuration.save'},
    ]);
  });

  it('builds native port-role command order with string port values', () => {
    expect(buildSetPortRoleQueries('02:7d:4a:91:c3:21', '0', 'primary', 'disabled')).toEqual([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '0', access: {no: true}}}},
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '0', disable: {}}}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetPortRoleQueries('02:7d:4a:91:c3:21', '1', 'disabled', 'primary')).toEqual([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '1', disable: {no: true}}}},
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '1', access: {no: true}}}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetPortRoleQueries('02:7d:4a:91:c3:21', '2', 'primary', {segment: 'Bridge1'})).toEqual([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '2', access: {interface: 'Bridge1'}}}},
      {path: 'system.configuration.save'},
    ]);
  });

  it('clears disabled state before assigning a segment and skips same-role saves', () => {
    expect(buildSetPortRoleQueries('02:7d:4a:91:c3:21', '0', 'disabled', {segment: 'Bridge2'})).toEqual([
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '0', disable: {no: true}}}},
      {path: 'mws.member', data: {member: '02:7d:4a:91:c3:21', port: {port: '0', access: {interface: 'Bridge2'}}}},
      {path: 'system.configuration.save'},
    ]);
    expect(buildSetPortRoleQueries('02:7d:4a:91:c3:21', '0', 'primary', 'primary')).toEqual([]);
  });

  it('rejects invalid MAC, port, and segment values', () => {
    expect(() => buildSetNameQueries('bad', 'Name')).toThrow('invalid MAC');
    expect(() => buildSetPortRoleQueries('02:7d:4a:91:c3:21', '0', 'invalid')).toThrow('invalid port role');
    expect(() => buildSetPortRoleQueries('02:7d:4a:91:c3:21', 'x', 'primary')).toThrow('invalid port');
    expect(() => buildSetPortRoleQueries('02:7d:4a:91:c3:21', '0', {segment: ''})).toThrow('invalid port role');
  });
});
