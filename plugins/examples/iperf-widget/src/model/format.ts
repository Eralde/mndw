const SCALE_TICKS_MBPS = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 2500, 10000];

export function formatBitRate(bitsPerSecond: number, locale: string): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    return '0 Mbit/s';
  }

  const isGigabits = bitsPerSecond >= 1e9;
  const value = bitsPerSecond / (isGigabits ? 1e9 : 1e6);
  const formatted = new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(value);

  return `${formatted} ${isGigabits ? 'Gbit/s' : 'Mbit/s'}`;
}

export function gaugeTop(bitsPerSecond: number): 1000 | 2500 | 10000 {
  if (bitsPerSecond > 2_500e6) {
    return 10000;
  }

  if (bitsPerSecond > 1_000e6) {
    return 2500;
  }

  return 1000;
}

export function gaugeAngle(bitsPerSecond: number, top: 1000 | 2500 | 10000 = 10000): number {
  const scale = SCALE_TICKS_MBPS.filter((tick) => tick <= top).map((tick) => tick * 1e6);
  const bounded = Math.max(0, Math.min(bitsPerSecond, top * 1e6));
  const segment = scale.findIndex((tick) => tick >= bounded);

  if (segment <= 0) {
    return 0;
  }

  const start = scale[segment - 1] ?? 0;
  const end = scale[segment] ?? start;
  const fraction = end === start ? 0 : (bounded - start) / (end - start);

  return ((segment - 1 + fraction) / (scale.length - 1)) * 180;
}
