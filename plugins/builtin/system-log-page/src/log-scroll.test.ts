import {describe, expect, it, vi} from 'vitest';
import {NEAR_BOTTOM_PX, isNearBottom, readScrollMetrics} from './log-scroll';

describe('log scroll metrics', () => {
  it('reads injected happy-dom metrics without relying on layout', () => {
    const viewport = document.createElement('div');
    let scrollTop = 0;
    let clientHeight = 50;
    let scrollHeight = 100;
    const scrollTo = vi.fn();

    Object.defineProperties(viewport, {
      scrollTop: {configurable: true, get: () => scrollTop},
      clientHeight: {configurable: true, get: () => clientHeight},
      scrollHeight: {configurable: true, get: () => scrollHeight},
      scrollTo: {configurable: true, value: scrollTo},
    });

    expect(readScrollMetrics(viewport)).toEqual({scrollTop: 0, clientHeight: 50, scrollHeight: 100});
    expect(isNearBottom(readScrollMetrics(viewport))).toBe(false);

    scrollTop = 32;
    expect(isNearBottom(readScrollMetrics(viewport))).toBe(true);
    expect(NEAR_BOTTOM_PX).toBe(32);

    clientHeight = 50;
    scrollHeight = 200;
    expect(isNearBottom(readScrollMetrics(viewport))).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
