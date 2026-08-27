export interface UptimeBaseline {
  readonly deviceSeconds: number;
  readonly syncedAtMs: number;
}

export function createUptimeBaseline(deviceSeconds: number | null, syncedAtMs: number): UptimeBaseline | null {
  if (deviceSeconds === null || !Number.isFinite(deviceSeconds) || !Number.isFinite(syncedAtMs)) {
    return null;
  }

  return {deviceSeconds, syncedAtMs};
}

export function getUptimeSeconds(baseline: UptimeBaseline | null, nowMs: number): number | null {
  if (baseline === null || !Number.isFinite(nowMs)) {
    return null;
  }

  return baseline.deviceSeconds + Math.floor((nowMs - baseline.syncedAtMs) / 1000);
}
