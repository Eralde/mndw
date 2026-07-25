import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from '../api/rci.types';

export interface LargeMockSnapshot {
  members: MwsMemberRecord[];
  hosts: DeviceHostRecord[];
  bridge: BridgeInterfaceRecord;
  version: ShowVersionRecord;
}

const CONTROLLER_MAC = '02:7d:4a:91:c3:10';
const MODELS = ['Buddy 6 (KN-3411)', 'Atlas SE (KN-4310)', 'Hopper (KN-3811)'];

function extenderMac(index: number): string {
  return `02:7d:4a:91:c4:${(0x20 + index).toString(16).padStart(2, '0')}`;
}

function clientMac(index: number): string {
  const suffix = (0x1000 + index).toString(16).padStart(4, '0');

  return `02:7d:4a:92:${suffix.slice(0, 2)}:${suffix.slice(2)}`;
}

function cid(index: number): string {
  return `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`;
}

function parentFor(index: number): {mac: string; type: 'wired' | 'wireless'} {
  if (index > 0 && index % 6 === 0) {
    return {mac: CONTROLLER_MAC, type: 'wired'};
  }

  if (index % 3 === 0) {
    return {mac: CONTROLLER_MAC, type: 'wireless'};
  }

  return {mac: extenderMac(index - 1), type: index % 2 === 1 ? 'wired' : 'wireless'};
}

function createMember(index: number): MwsMemberRecord {
  const parent = parentFor(index);
  const mac = extenderMac(index);
  const isWireless = parent.type === 'wireless';

  return {
    cid: cid(index),
    mac,
    model: MODELS[index % MODELS.length],
    knownHost: `Mock Extender ${String.fromCharCode(65 + (index % 26))}`,
    ip: `192.168.1.${100 + index}`,
    fw: '5.1.1',
    fwAvailable: index % 4 === 0 ? '5.2.0' : '5.1.1',
    system: {
      cpuload: index % 5,
      memoryUsed: 120000 + index * 4096,
      memoryTotal: 262144,
      uptime: 900 + index * 37,
    },
    backhaul: {
      uplink: isWireless ? `WifiMaster1/WifiStation${index % 2}` : `GigabitEthernet${(index % 4) + 1}`,
      bridge: `${isWireless ? '8000' : 'e000'}.${parent.mac}`,
      parentMac: parent.mac,
      ap: isWireless ? `WifiMaster1/Backhaul${index % 2}` : null,
      rssi: isWireless ? -35 - index : null,
      txrate: isWireless ? 800 + index * 40 : null,
      mode: isWireless ? '11ax' : null,
      security: isWireless ? 'wpa3-psk' : null,
      cost: 50 + index,
      speed: isWireless ? null : index % 5 === 0 ? '100' : '1000',
      duplex: isWireless ? null : 'full',
      portLabel: isWireless ? null : String(index % 4),
    },
  };
}

function createHost(index: number, extenderCount: number, members: MwsMemberRecord[]): DeviceHostRecord {
  const target = extenderCount === 0 ? 0 : index % (extenderCount + 1);
  const member = target === 0 ? undefined : members[target - 1];
  const wired = index % 3 === 0 || (member !== undefined && index % 4 === 0);

  return {
    mac: clientMac(index),
    name: `Mock Client ${String(index + 1).padStart(2, '0')}`,
    ip: `192.168.1.${20 + index}`,
    uptime: 60 + index * 11,
    lastSeen: index % 3,
    wired,
    mwsCid: member?.cid ?? null,
  };
}

export function createLargeMockSnapshot(extenderCount: number, clientCount: number): LargeMockSnapshot {
  const members = Array.from({length: Math.max(0, extenderCount)}, (_, index) => createMember(index));
  const hosts = Array.from(
    {length: Math.max(0, clientCount)},
    (_, index) => createHost(index, members.length, members),
  );

  return {
    members,
    hosts,
    bridge: {mac: CONTROLLER_MAC, address: '192.168.1.1', uptime: 7200, isOnline: true},
    version: {model: 'Hopper (KN-3811)', firmware: '5.2 Alpha 1'},
  };
}
