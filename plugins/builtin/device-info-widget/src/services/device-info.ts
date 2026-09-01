import type {RciManager, RciQuery} from '@rci-tools/core';
import {firstValueFrom} from 'rxjs';
import {type RrdResponse, type RrdTick, filterValidRrdTicks, sortRrdTicks} from '@mndw/sdk/rrd';

import {normalizeHistory, normalizePercent} from './load-history.js';

export interface LiveDeviceInfo {
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

function getRrdHistory(response: RrdResponse, valueMapper: (tick: RrdTick) => number): number[] {
  const values = sortRrdTicks(filterValidRrdTicks(response.data ?? [])).map(valueMapper);

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
export async function fetchDeviceInfo(rci: RciManager): Promise<LiveDeviceInfo> {
  const queries: RciQuery[] = [
    {path: 'show.identification'},
    {path: 'show.system'},
    {
      path: 'show.system.rrd.cpu',
      data: {detail: 0, attribute: 'avg'},
    },
    {
      path: 'show.system.rrd.memory',
      data: {detail: 0, attribute: 'used'},
    },
  ];

  const obs$ = rci.queue(queries);

  const [identification, system, cpuResponse, memoryResponse] = await firstValueFrom(obs$) as [
    Identification | undefined,
    System | undefined,
    RrdResponse | undefined,
    RrdResponse | undefined,
  ];

  if (identification === undefined || system === undefined) {
    throw new Error('Required device information is unavailable.');
  }

  const memoryTotal = system.memtotal ?? Number.NaN;
  const memoryUsed = Number(system.memory?.split('/')[0] ?? Number.NaN);

  return {
    uptimeSeconds: toUptimeSeconds(system.uptime),
    cpuLoadPercent: normalizePercent(system.cpuload ?? Number.NaN) ?? 0,
    ramLoadPercent: normalizePercent((memoryUsed / memoryTotal) * 100) ?? 0,
    cpuHistory: getRrdHistory(cpuResponse ?? {data: []}, (tick) => tick.v),
    ramHistory: getRrdHistory(memoryResponse ?? {data: []}, (tick) => (tick.v / memoryTotal) * 100),
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
