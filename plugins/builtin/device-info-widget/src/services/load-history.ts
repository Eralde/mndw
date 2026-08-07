export const MAX_LOAD_HISTORY_POINTS = 64;

export function normalizePercent(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

export function normalizeHistory(values: number[]): number[] {
  return values
    .map(normalizePercent)
    .filter((value): value is number => value !== null)
    .slice(-MAX_LOAD_HISTORY_POINTS);
}
