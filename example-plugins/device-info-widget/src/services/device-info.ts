import type {RciManager, RciQuery} from '@rci-tools/core';
import {firstValueFrom} from 'rxjs';

import {normalizeHistory, normalizePercent} from './load-history.js';

export interface DeviceInfo {
  model: string;
  uptimeSeconds: number | null;
  cpuLoadPercent: number;
  ramLoadPercent: number;
  cpuHistory: number[];
  ramHistory: number[];
  serial: string;
  serviceTag: string;
  mac: string;
  hwid: string;
  cid: string;
}

interface Identification {
  servicetag?: string;
  serial?: string;
  mac?: string;
  hwid?: string;
  cid?: string;
}

interface System {
  uptime?: number | string;
  cpuload?: number;
  memtotal?: number;
  memory?: string;
}

interface Version {
  model?: string;
}

export interface RrdTick {
  t: string | number;
  v: number;
}

export interface RrdResponse {
  data?: RrdTick[];
}

function getRrdHistory(response: RrdResponse, valueMapper: (tick: RrdTick) => number): number[] {
  const values = (response.data ?? [])
    .filter((tick) => Number.isFinite(Number(tick.t)) && Number.isFinite(tick.v))
    .sort((left, right) => Number(left.t) - Number(right.t))
    .map(valueMapper);

  return normalizeHistory(values);
}

/** Coerces `show.system.uptime` (string or number on real firmware) to a finite number, else null. */
function toUptimeSeconds(value: number | string | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const num = typeof value === 'string' ? Number(value) : value;

  return Number.isFinite(num) ? num : null;
}

/** Reads required identity/system data and isolates optional load-history failures. */
export async function fetchDeviceInfo(rci: RciManager): Promise<DeviceInfo> {
  const identificationQuery: RciQuery = {path: 'show.identification', extractData: true};
  const systemQuery: RciQuery = {path: 'show.system', extractData: true};
  const versionQuery: RciQuery = {path: 'show.version', extractData: true};
  const cpuQuery: RciQuery = {
    path: 'show.system.rrd.cpu',
    extractData: true,
    data: {detail: 0, attribute: 'avg'},
  };
  const memoryQuery: RciQuery = {
    path: 'show.system.rrd.memory',
    extractData: true,
    data: {detail: 0, attribute: 'used'},
  };

  const [identification, system, version, cpuResponse, memoryResponse] = await Promise.all([
    firstValueFrom(rci.queue(identificationQuery)) as Promise<Identification>,
    firstValueFrom(rci.queue(systemQuery)) as Promise<System>,
    firstValueFrom(rci.queue(versionQuery)).catch(() => ({}) as Version) as Promise<Version>,
    firstValueFrom(rci.queue(cpuQuery)).catch(() => ({data: []})) as Promise<RrdResponse>,
    firstValueFrom(rci.queue(memoryQuery)).catch(() => ({data: []})) as Promise<RrdResponse>,
  ]);

  const memoryTotal = system.memtotal ?? Number.NaN;
  const memoryUsed = Number(system.memory?.split('/')[0] ?? Number.NaN);

  return {
    model: version.model ?? 'Unknown',
    uptimeSeconds: toUptimeSeconds(system.uptime),
    cpuLoadPercent: normalizePercent(system.cpuload ?? Number.NaN) ?? 0,
    ramLoadPercent: normalizePercent((memoryUsed / memoryTotal) * 100) ?? 0,
    cpuHistory: getRrdHistory(cpuResponse, (tick) => tick.v),
    ramHistory: getRrdHistory(memoryResponse, (tick) => (tick.v / memoryTotal) * 100),
    serial: identification.serial ?? '',
    serviceTag: identification.servicetag ?? '',
    mac: identification.mac ?? '',
    hwid: identification.hwid ?? '',
    cid: identification.cid ?? '',
  };
}

/** Full-word pluralized non-zero parts joined by ", ". */
export function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  }

  if (hours > 0) {
    parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  }

  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  }

  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`);
  }

  return parts.join(', ');
}
