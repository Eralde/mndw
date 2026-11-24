export interface RssiThresholds {
  good: number;
  fair: number;
}

export const RSSI_MIN = -100;
export const RSSI_MAX = -20;

export const DEFAULT_RSSI_THRESHOLDS: RssiThresholds = {good: -65, fair: -75};

export type RssiQuality = 'good' | 'fair' | 'weak' | 'unknown';

/** A threshold is an integer dBm value the router can actually report. */
export function isValidRssiThreshold(value: number): boolean {
  return Number.isInteger(value) && value >= RSSI_MIN && value <= RSSI_MAX;
}

export function isValidRssiThresholds(value: unknown): value is RssiThresholds {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const {good, fair} = value as Record<string, unknown>;

  return typeof good === 'number'
    && typeof fair === 'number'
    && isValidRssiThreshold(good)
    && isValidRssiThreshold(fair)
    && good > fair;
}

export function rssiQuality(rssi: number | null, thresholds: RssiThresholds): RssiQuality {
  if (rssi === null || !Number.isFinite(rssi)) {
    return 'unknown';
  }

  if (rssi >= thresholds.good) {
    return 'good';
  }

  if (rssi >= thresholds.fair) {
    return 'fair';
  }

  return 'weak';
}
