import type {MwsLiveTelemetry} from '../domain/mws/mws.types';
import {parseLiveTelemetry} from './mwsd-status';

/** One radio's raw `show interface channel-utilization chart` response, tagged with its interface. */
export interface ControllerWifiChart {
  readonly interface: string;
  readonly chart: unknown;
}

/**
 * The controller's own live utilization, sourced directly through the RciManager
 * rather than a persistent session: current CPU/RAM plus the full history series.
 */
export interface ControllerTelemetry {
  readonly cpuload: number | null;
  readonly memoryUsed: number | null;
  readonly memoryTotal: number | null;
  readonly telemetry: MwsLiveTelemetry;
}

/**
 * Assembles controller telemetry from the raw `show system`, CPU/memory RRD, and
 * per-radio channel-utilization responses, reusing the persistent-session parser
 * by rebuilding its `{system, cpuRrd, memoryRrd, wifiUtil}` envelope.
 */
export function parseControllerTelemetry(
  system: unknown,
  cpuRrd: unknown,
  memoryRrd: unknown,
  wifiCharts: readonly ControllerWifiChart[],
  sampledAt: number,
): ControllerTelemetry | null {
  const systemRecord = asRecord(system);
  const memory = parseMemory(systemRecord?.memory);
  const memTotal = toFiniteNumber(systemRecord?.memtotal) ?? memory.total;

  const wifiUtil = wifiCharts
    .map((entry) => flattenWifiChart(entry))
    .filter((entry): entry is {interface: string; t: number[]; load: number[]} => entry !== null);

  const telemetry = parseLiveTelemetry(
    {system: {memtotal: memTotal}, cpuRrd, memoryRrd, wifiUtil},
    sampledAt,
  );

  if (telemetry === null) {
    return null;
  }

  return {
    cpuload: toFiniteNumber(systemRecord?.cpuload),
    memoryUsed: memory.used,
    memoryTotal: memTotal,
    telemetry,
  };
}

function flattenWifiChart(entry: ControllerWifiChart): {interface: string; t: number[]; load: number[]} | null {
  const data = asRecord(entry.chart)?.data;

  if (!Array.isArray(data)) {
    return null;
  }

  const t: number[] = [];
  const load: number[] = [];

  for (const tick of data) {
    const record = asRecord(tick);
    const time = toFiniteNumber(record?.t);
    const value = toFiniteNumber(asRecord(record?.v)?.load);

    if (time !== null && value !== null) {
      t.push(time);
      load.push(value);
    }
  }

  return load.length === 0 ? null : {interface: entry.interface, t, load};
}

function parseMemory(value: unknown): {used: number | null; total: number | null} {
  const match = /^(\d+)\/(\d+)$/.exec(typeof value === 'string' ? value : '');

  return match === null ? {used: null, total: null} : {used: Number(match[1]), total: Number(match[2])};
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
