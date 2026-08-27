import {normalizeHistory} from '../services/load-history.js';

export const prepareChartHistory = normalizeHistory;

export interface ChartBar {
  readonly value: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function hasChartHistory(history: number[]): boolean {
  return normalizeHistory(history).length > 0;
}

/**
 * Lays out a 0..100 percentage series as filled bars inside a `width` x `height`
 * box. Bars share the available width evenly, separated by `gap` pixels, and
 * grow upward from the baseline. Values are assumed to be already normalized.
 */
export function computeChartBars(history: number[], width: number, height: number, gap: number): ChartBar[] {
  if (history.length === 0 || width <= 0 || height <= 0) {
    return [];
  }

  const slot = width / history.length;
  const barWidth = Math.max(1, slot - gap);

  return history.map((value, index) => {
    const barHeight = Math.max(1, (value / 100) * height);

    return {
      value,
      left: index * slot,
      top: height - barHeight,
      width: barWidth,
      height: barHeight,
    };
  });
}

/**
 * Maps a horizontal offset within a `width`-wide chart to the index of the bar
 * underneath it, so pointer tracking works anywhere over the plot area (bars and
 * the gaps between them alike). Returns `null` when there is nothing to hover.
 */
export function barIndexAt(offsetX: number, width: number, count: number): number | null {
  if (count === 0 || width <= 0) {
    return null;
  }

  const index = Math.floor((offsetX / width) * count);

  return Math.min(count - 1, Math.max(0, index));
}
