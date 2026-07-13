import type {RciManager, RciQuery} from '@rci-tools/core';
import {firstValueFrom} from 'rxjs';

export interface DeviceInfo {
  model: string;
  uptimeSeconds: number | null;
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
  model?: string;
  uptime?: number;
}

/**
 * Two RCI queries resolved together (v2 `RciManager.queue` takes a single query; two calls match
 * device-traffic's typed pattern). Rejects if either query errors; falls back per field otherwise.
 */
export async function fetchDeviceInfo(rci: RciManager): Promise<DeviceInfo> {
  const identificationQuery: RciQuery = {path: 'show.identification', extractData: true};
  const systemQuery: RciQuery = {path: 'show.system', extractData: true};

  const [identification, system] = await Promise.all([
    firstValueFrom(rci.queue(identificationQuery)) as Promise<Identification>,
    firstValueFrom(rci.queue(systemQuery)) as Promise<System>,
  ]);

  return {
    model: system.model ?? 'Unknown',
    uptimeSeconds: system.uptime ?? null,
    serial: identification.serial ?? '',
    serviceTag: identification.servicetag ?? '',
    mac: identification.mac ?? '',
    hwid: identification.hwid ?? '',
    cid: identification.cid ?? '',
  };
}

/** `< 60s` → "< 1 minute"; otherwise full-word pluralized non-zero parts joined by ", ". */
export function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return '< 1 minute';
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
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

  return parts.join(', ');
}
