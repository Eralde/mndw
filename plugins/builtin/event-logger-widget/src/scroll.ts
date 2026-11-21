export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Rounds sub-pixel layout and momentum so "at the bottom" does not flicker. */
export const BOTTOM_THRESHOLD_PX = 8;

export function isAtBottom(element: ScrollMetrics, threshold = BOTTOM_THRESHOLD_PX): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}
