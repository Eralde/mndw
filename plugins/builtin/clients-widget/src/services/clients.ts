import type {RciManager, RciQuery} from '@rci-tools/core';
import {firstValueFrom} from 'rxjs';
import {get, has, pickBy} from 'lodash-es';

interface RawDeviceHost {
  mac?: unknown;
  ip?: unknown;
  hostname?: unknown;
  name?: unknown;
  'mws-backhaul'?: unknown;
  'system-mode'?: unknown;
  active?: unknown;
  link?: unknown;
  speed?: unknown;
  port?: unknown;
  uptime?: unknown;
  'last-seen'?: unknown;
}

export interface WiredConnectionInfo {
  speed: number | null;
  port: string | null;
}

export type WifiBand = '2' | '5' | '6';
export type HostConnectionType = 'wired' | 'wireless' | 'unknown';

export interface WirelessConnectionInfo {
  accessPointId: string;
  bands: WifiBand[];
  txrate: number;
  rssi: number;
  txss: number;
}

export interface ClientRecord {
  mac: string;
  displayName: string;
  ip: string | null;
  link: 'up' | 'down' | null;
  active: boolean;
  connectionType: HostConnectionType;
  connection: WiredConnectionInfo | WirelessConnectionInfo | null;
  uptime: number | null;
  lastSeen: number | null;
}

export class ClientsParseError extends Error {
  public constructor(message: string) {
    super(message);

    this.name = 'ClientsParseError';
  }
}

const MAC_PATTERN = /^[0-9A-Fa-f][02468ACEace](?::[0-9A-Fa-f]{2}){5}$/;
const QUERY: RciQuery = {path: 'show.device-list', extractData: true};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toPort(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }

  return toText(value);
}

function toMac(value: unknown, index: number): string {
  const text = toText(value)?.toLowerCase() ?? null;

  if (text === null || !MAC_PATTERN.test(text)) {
    throw new ClientsParseError(`show.device-list host[${index}]: invalid mac`);
  }

  return text;
}

function isClient(host: RawDeviceHost): boolean {
  return host['system-mode'] !== 'extender' && host['mws-backhaul'] !== true;
}

const getHostConnectionType = (host: RawDeviceHost): HostConnectionType => {
  if (!host.active) {
    return 'unknown';
  }

  // host connected via MLO Wi-Fi
  if (Number(get(host, 'mld.length')) > 0) {
    return 'wireless';
  }

  return (has(host, 'ap') || has(host, 'mws.ap'))
    ? 'wireless'
    : 'wired';
};

const getWiredConnectionInfo = (host: RawDeviceHost): WiredConnectionInfo => {
  const speed = has(host, 'mws.speed') ? get(host, 'mws.speed') : host.speed;
  const port = has(host, 'mws.port') ? get(host, 'mws.port') : host.port;

  return {
    speed: toNumber(speed),
    port: toPort(port),
  };
};

const getWirelessConnectionInfo = (host: RawDeviceHost): WirelessConnectionInfo => {
  const dataObject = has(host, 'mws')
    ? get(host, 'mws')
    : host;

  const connectionInfo = pickBy({
    txss: get(dataObject, 'txss'),
    txrate: get(dataObject, 'txrate'),
    rssi: get(dataObject, 'rssi'),
    security: get(dataObject, 'security'),
    ht: get(dataObject, 'ht'),
    ap: get(dataObject, 'ap'),
  });

  const accessPointId = connectionInfo.ap ?? '';
  const bands = ['2' as const]; // TODO: get real bands list

  return {
    accessPointId,
    bands,
    txss: connectionInfo.txss ?? 0,
    txrate: connectionInfo.txrate ?? 0,
    rssi: connectionInfo.rssi ?? 0,
  };
};

function toRecord(host: RawDeviceHost, index: number): ClientRecord {
  const mac = toMac(host.mac, index);
  const link = host.link === 'up' || host.link === 'down' ? host.link : null;
  const connectionType = getHostConnectionType(host);
  let connection: ClientRecord['connection'] = null;

  if (connectionType === 'wired') {
    connection = getWiredConnectionInfo(host);
  } else if (connectionType === 'wireless') {
    connection = getWirelessConnectionInfo(host);
  }

  return {
    mac,
    displayName: toText(host.name) ?? toText(host.hostname) ?? mac,
    ip: toText(host.ip),
    link,
    connection,
    connectionType,
    uptime: toNumber(host.uptime),
    lastSeen: toNumber(host['last-seen']),
    active: host.active === true,
  };
}

export function normalizeClients(raw: unknown): ClientRecord[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.host)) {
    throw new ClientsParseError('show.device-list: expected a host array');
  }

  const records: ClientRecord[] = [];

  raw.host.forEach((entry: unknown, index: number) => {
    if (!isPlainObject(entry)) {
      throw new ClientsParseError(`show.device-list host[${index}]: expected an object`);
    }

    const host = entry as RawDeviceHost;
    const record = toRecord(host, index);

    if (isClient(host)) {
      records.push(record);
    }
  });

  return records.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function filterVisibleClients(clients: ClientRecord[], showOffline: boolean): ClientRecord[] {
  return showOffline ? clients : clients.filter((client) => client.active);
}

export async function fetchClients(rci: RciManager): Promise<ClientRecord[]> {
  return normalizeClients(await firstValueFrom(rci.queue(QUERY)));
}
