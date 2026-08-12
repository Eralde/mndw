export interface MwsClient {
  mac: string;
  name: string;
  ip: string | null;
  uptime: number | null;
  lastSeen: number | null;
  wired: boolean;
}

export interface MwsLink {
  type: 'wired' | 'wireless';
  node: MwsNode;
}

export interface MwsSystem {
  cpuload: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  uptime: number | null;
}

export interface MwsBackhaul {
  uplink: string | null;
  bridge: string | null;
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

export interface MwsRadioPower {
  readonly value: number | null;
  readonly available: boolean;
}

export interface MwsNode {
  /** Normalized MAC — also the graph identity. */
  id: string;
  cid: string | null;
  name: string;
  model: string | null;
  ip: string | null;
  mac: string;
  isController: boolean;
  isOnline: boolean;
  fw: string | null;
  fwAvailable: string | null;
  system: MwsSystem | null;
  backhaul: MwsBackhaul | null;
  parent: MwsLink | null;
  children: MwsLink[];
  clients: MwsClient[];
  dualBand: boolean;
  wifiPower?: {
    readonly power2g: MwsRadioPower;
    readonly power5g: MwsRadioPower;
  };
  mwsdStatus?: MwsdNodeStatus;
  persistentSession?: boolean;
}

export interface MwsdNodeStatus {
  readonly state: 'starting' | 'live' | 'stale' | 'offline' | 'unavailable';
  readonly lastTelemetryAt: number | null;
}

export interface ControllerInfo {
  mac: string;
  ip: string | null;
  name: string;
  model: string | null;
  firmware: string | null;
  interfaceUptime: number | null;
  isOnline: boolean;
}
