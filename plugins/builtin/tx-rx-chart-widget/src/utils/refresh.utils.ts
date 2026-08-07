export const REFRESH_MIN_MS = 1000;
export const REFRESH_MAX_MS = 5000;
export const REFRESH_STEP_MS = 500;
export const DEFAULT_REFRESH_MS = 3000;

export function refreshSecondsToMs(value: string): number {
  return Math.round(Number(value) * REFRESH_MIN_MS);
}

export function refreshMsToSeconds(value: number): number {
  return value / REFRESH_MIN_MS;
}

export function normalizeRefreshMs(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') {
    return DEFAULT_REFRESH_MS;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_REFRESH_MS;
  }

  const stepped = Math.round(parsed / REFRESH_STEP_MS) * REFRESH_STEP_MS;

  return Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, stepped));
}
