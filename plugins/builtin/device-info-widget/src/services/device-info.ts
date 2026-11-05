import type {PluginRciManager} from '@mndw/sdk';
import type {RciQuery} from '@rci-tools/core';
import {catchError, firstValueFrom, forkJoin, of} from 'rxjs';
import {type RrdResponse, type RrdTick, filterValidRrdTicks, sortRrdTicks} from '@mndw/sdk/rrd';

import {normalizeHistory, normalizePercent} from './load-history.js';

export interface LiveDeviceInfo {
  uptimeSeconds: number | null;
  cpuLoadPercent: number;
  ramLoadPercent: number;
  cpuHistory: number[];
  ramHistory: number[];
  memoryTotal: number | null;
  serial: string;
  serviceTag: string;
  mac: string;
  hwid: string;
  cid: string;
}

export type DeviceInfoRange = '3m' | '1h' | '3h' | '1d';

export interface LoadHistory {
  cpuHistory: number[];
  ramHistory: number[];
}

const DEVICE_INFO_DETAILS: Readonly<Record<DeviceInfoRange, number>> = {
  '3m': 0,
  '1h': 1,
  '3h': 2,
  '1d': 3,
};

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

function historyQueries(detail: number): readonly [RciQuery, RciQuery] {
  return [
    {path: 'show.system.rrd.cpu', data: {detail, attribute: 'avg'}},
    {path: 'show.system.rrd.memory', data: {detail, attribute: 'used'}},
  ];
}

function readMemoryTotal(system: System): number | null {
  return system.memtotal !== undefined && Number.isFinite(system.memtotal) ? system.memtotal : null;
}

function mapLoadHistory(
  cpuResponse: RrdResponse | undefined,
  ramResponse: RrdResponse | undefined,
  memoryTotal: number | null,
): LoadHistory {
  return {
    cpuHistory: getRrdHistory(cpuResponse ?? {data: []}, (tick) => tick.v),
    ramHistory: getRrdHistory(
      ramResponse ?? {data: []},
      (tick) => (tick.v / (memoryTotal ?? Number.NaN)) * 100,
    ),
  };
}

/** Coerces `show.system.uptime` (string or number on real firmware) to a finite number, else null. */
function toUptimeSeconds(value: number | string | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const num = typeof value === 'string' ? Number(value) : value;

  return Number.isFinite(num) ? num : null;
}

/** Reads selected identity/system data and isolates optional load-history failures. */
export async function fetchDeviceInfo(rci: PluginRciManager, detail = 0): Promise<LiveDeviceInfo> {
  const [cpuQuery, memoryQuery] = historyQueries(detail);
  const optional = (query: RciQuery) => rci.queue(query).pipe(catchError(() => of(undefined)));
  const responses = await firstValueFrom(forkJoin([
    rci.queue({path: 'show.identification'}),
    rci.queue({path: 'show.system'}),
    optional(cpuQuery),
    optional(memoryQuery),
  ]));
  const identification = responses[0] as Identification | undefined;
  const system = responses[1] as System | undefined;

  if (identification === undefined || system === undefined) {
    throw new Error('Required device information is unavailable.');
  }

  const memoryTotal = readMemoryTotal(system);
  const memoryUsed = Number(system.memory?.split('/')[0] ?? Number.NaN);
  const loadHistory = mapLoadHistory(
    responses[2] as RrdResponse | undefined,
    responses[3] as RrdResponse | undefined,
    memoryTotal,
  );

  return {
    uptimeSeconds: toUptimeSeconds(system.uptime),
    cpuLoadPercent: normalizePercent(system.cpuload ?? Number.NaN) ?? 0,
    ramLoadPercent: normalizePercent((memoryUsed / (memoryTotal ?? Number.NaN)) * 100) ?? 0,
    ...loadHistory,
    memoryTotal,
    serial: identification.serial ?? '',
    serviceTag: identification.servicetag ?? '',
    mac: identification.mac ?? '',
    hwid: identification.hwid ?? '',
    cid: identification.cid ?? '',
  };
}

/** Reads CPU and memory history for one selected live range. */
export async function fetchDeviceHistory(
  rci: PluginRciManager,
  detail: number,
  memoryTotal: number | null,
): Promise<LoadHistory> {
  const [cpuQuery, memoryQuery] = historyQueries(detail);
  const optional = (query: RciQuery) => rci.queue(query).pipe(catchError(() => of(undefined)));
  const responses = await firstValueFrom(forkJoin([optional(cpuQuery), optional(memoryQuery)]));

  return mapLoadHistory(
    responses[0] as RrdResponse | undefined,
    responses[1] as RrdResponse | undefined,
    memoryTotal,
  );
}

export function deviceInfoDetail(range: DeviceInfoRange): number {
  return DEVICE_INFO_DETAILS[range];
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
