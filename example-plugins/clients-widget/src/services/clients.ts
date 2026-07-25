import type {RciManager, RciQuery} from '@rci-tools/core';
import {firstValueFrom} from 'rxjs';

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

export interface ClientRecord {
  mac: string;
  displayName: string;
  ip: string | null;
  link: 'up' | 'down' | null;
  speed: number | null;
  port: string | null;
  uptime: number | null;
  lastSeen: number | null;
  active: boolean;
}

export class ClientsParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClientsParseError';
  }
}

const MAC_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
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

function toRecord(host: RawDeviceHost, index: number): ClientRecord {
  const mac = toMac(host.mac, index);
  const link = host.link === 'up' || host.link === 'down' ? host.link : null;

  return {
    mac,
    displayName: toText(host.name) ?? toText(host.hostname) ?? mac,
    ip: toText(host.ip),
    link,
    speed: toNumber(host.speed),
    port: toText(typeof host.port === 'number' ? String(host.port) : host.port),
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
