import type {RciManager, RciQuery} from '@rci-tools/core';
import {catchError, firstValueFrom, forkJoin, of} from 'rxjs';
import {type RrdResponse, type RrdTick, filterValidRrdTicks, sortRrdTicks} from '@mndw/sdk/rrd';

import {normalizeHistory, normalizePercent} from './load-history.js';

export interface LiveDeviceInfo {
  uptimeSeconds: number | null;
  cpuLoadPercent: number;
  ramLoadPercent: number;
  cpuHistory: number[];
  ramHistory: number[];
  cpuHistoryByRange: Record<DeviceInfoRange, number[]>;
  ramHistoryByRange: Record<DeviceInfoRange, number[]>;
  serial: string;
  serviceTag: string;
  mac: string;
  hwid: string;
  cid: string;
}

export type DeviceInfoRange = '3m' | '1h' | '3h' | '1d';

const DEVICE_INFO_RANGES: readonly {key: DeviceInfoRange; detail: number}[] = [
  {key: '3m', detail: 0},
  {key: '1h', detail: 1},
  {key: '3h', detail: 2},
  {key: '1d', detail: 3},
];

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
  const historyQueries = DEVICE_INFO_RANGES.flatMap(({detail}) =>
    [
      {path: 'show.system.rrd.cpu', data: {detail, attribute: 'avg'}},
      {path: 'show.system.rrd.memory', data: {detail, attribute: 'used'}},
    ] satisfies RciQuery[]
  );
  const optional = (query: RciQuery) => rci.queue(query).pipe(catchError(() => of(undefined)));
  const responses = await firstValueFrom(forkJoin([
    rci.queue({path: 'show.identification'}),
    rci.queue({path: 'show.system'}),
    ...historyQueries.map(optional),
  ]));
  const identification = responses[0] as Identification | undefined;
  const system = responses[1] as System | undefined;

  if (identification === undefined || system === undefined) {
    throw new Error('Required device information is unavailable.');
  }

  const histories = DEVICE_INFO_RANGES.map(({key}, index) => {
    const cpuResponse = responses[2 + index * 2] as RrdResponse | undefined;
    const ramResponse = responses[3 + index * 2] as RrdResponse | undefined;

    return {
      key,
      cpu: getRrdHistory(cpuResponse ?? {data: []}, (tick) => tick.v),
      ram: getRrdHistory(ramResponse ?? {data: []}, (tick) => (tick.v / (system.memtotal ?? Number.NaN)) * 100),
    };
  });

  const memoryTotal = system.memtotal ?? Number.NaN;
  const memoryUsed = Number(system.memory?.split('/')[0] ?? Number.NaN);
  const cpuHistoryByRange = Object.fromEntries(histories.map((item) => [item.key, item.cpu])) as Record<DeviceInfoRange,
    number[]>;
  const ramHistoryByRange = Object.fromEntries(histories.map((item) => [item.key, item.ram])) as Record<DeviceInfoRange,
    number[]>;

  return {
    uptimeSeconds: toUptimeSeconds(system.uptime),
    cpuLoadPercent: normalizePercent(system.cpuload ?? Number.NaN) ?? 0,
    ramLoadPercent: normalizePercent((memoryUsed / memoryTotal) * 100) ?? 0,
    cpuHistory: cpuHistoryByRange['3m'] ?? [],
    ramHistory: ramHistoryByRange['3m'] ?? [],
    cpuHistoryByRange,
    ramHistoryByRange,
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
