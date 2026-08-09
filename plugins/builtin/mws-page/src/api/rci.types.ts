/** Raw RCI response shapes — only the fields the map reads. Extra fields are ignored. */

export interface RawMwsMemberBackhaul {
  uplink?: string;
  bridge?: string;
  ap?: string;
  rssi?: number;
  txrate?: number;
  mode?: string;
  security?: string;
  cost?: number;
  speed?: string;
  duplex?: boolean | string;
  'port-label'?: string;
}

export interface RawMwsMember {
  cid?: string;
  mac?: string;
  model?: string;
  'known-host'?: string;
  ip?: string;
  capabilities?: {'dual-band'?: unknown} | null;
  fw?: string;
  'fw-available'?: string;
  system?: {cpuload?: number; memory?: string; uptime?: string};
  backhaul?: RawMwsMemberBackhaul;
}

export interface RawDeviceHost {
  mac?: string;
  ip?: string;
  hostname?: string;
  name?: string;
  'mws-backhaul'?: boolean;
  'system-mode'?: string;
  active?: boolean;
  uptime?: number;
  'last-seen'?: number;
  port?: string | number;
  mws?: {cid?: string};
}

export interface RawBridgeInterface {
  mac?: string;
  address?: string;
  uptime?: number;
  state?: string;
  link?: string;
  connected?: string;
}

export interface RawShowVersion {
  model?: string;
  description?: string;
  title?: string;
  release?: string;
}

/** Normalized records exposed by the API boundary to the domain layer. */

export interface MwsMemberSystem {
  cpuload: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  uptime: number | null;
}

export interface MwsMemberBackhaul {
  uplink: string | null;
  bridge: string | null;
  /** Lowercase MAC extracted from `bridge`, or null when no MAC suffix parses. */
  parentMac: string | null;
  ap: string | null;
  rssi: number | null;
  txrate: number | null;
  mode: string | null;
  security: string | null;
  cost: number | null;
  speed: string | null;
  duplex: string | null;
  portLabel: string | null;
}

export interface MwsMemberRecord {
  cid: string;
  mac: string;
  model: string | null;
  knownHost: string | null;
  ip: string | null;
  fw: string | null;
  fwAvailable: string | null;
  system: MwsMemberSystem | null;
  backhaul: MwsMemberBackhaul | null;
  dualBand: boolean;
}

export interface DeviceHostRecord {
  mac: string;
  name: string;
  ip: string | null;
  uptime: number | null;
  lastSeen: number | null;
  wired: boolean;
  mwsCid: string | null;
}

export interface BridgeInterfaceRecord {
  mac: string;
  address: string | null;
  uptime: number | null;
  isOnline: boolean;
}

export interface ShowVersionRecord {
  model: string | null;
  firmware: string | null;
}
