export interface SparklineBar {
  readonly value: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Lays out a 0..`max` percentage series as filled bars inside a `width` x `height`
 * pixel box. Bars share the width evenly, separated by `gap` pixels, grow upward
 * from the baseline, and keep a 1px floor so even a zero sample stays visible.
 * Ported from the device-info widget's load bar chart.
 */
export function computeSparklineBars(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
  gap: number,
): SparklineBar[] {
  if (values.length === 0 || width <= 0 || height <= 0 || !(max > 0)) {
    return [];
  }

  const slot = width / values.length;
  const barWidth = Math.max(1, slot - gap);

  return values.map((value, index) => {
    const clamped = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), max);
    const barHeight = Math.max(1, (clamped / max) * height);

    return {value, left: index * slot, top: height - barHeight, width: barWidth, height: barHeight};
  });
}

/**
 * Maps a horizontal offset within a `width`-wide chart to the index of the bar
 * underneath it (bars and the gaps between them alike). Returns null when there
 * is nothing to hover.
 */
export function barIndexAt(offsetX: number, width: number, count: number): number | null {
  if (count === 0 || width <= 0) {
    return null;
  }

  const index = Math.floor((offsetX / width) * count);

  return Math.min(count - 1, Math.max(0, index));
}
