import {describe, expect, it, vi} from 'vitest';
import {SelectPopoverTracker, applySelectPopoverSizing} from './select-popover.js';

const rect = (top: number, bottom: number, width = 240): DOMRect => {
  return {top, bottom, left: 20, right: 20 + width, width, height: bottom - top} as DOMRect;
};

describe('select popover helpers', () => {
  it('projects trigger width and viewport-constrained height', () => {
    const element = document.createElement('div');

    applySelectPopoverSizing(element, rect(300, 332), {width: 1200, height: 868});

    expect(element.style.minWidth).toBe('240px');
    expect(element.style.maxWidth).toBe('calc(100vw - 16px)');
    expect(element.style.maxHeight).toBe('520px');
    expect(element.style.overflow).toBe('hidden');
  });

  it('tracks anchor movement independently of window events', () => {
    const scheduled: Array<() => void> = [];
    let currentRect = rect(10, 42);
    const reposition = vi.fn();
    const geometryChanges = vi.fn();
    const tracker = new SelectPopoverTracker({
      isActive: () => true,
      isConnected: () => true,
      readAnchorRect: () => currentRect,
      onGeometryChange: geometryChanges,
      onReposition: reposition,
      requestFrame: (callback) => {
        scheduled.push(callback);

        return 1;
      },
      cancelFrame: vi.fn(),
    });

    tracker.start();
    scheduled.shift()?.();
    currentRect = rect(100, 132);
    scheduled.shift()?.();

    expect(geometryChanges).toHaveBeenCalledTimes(2);
    expect(reposition).toHaveBeenCalledTimes(2);
    tracker.cancel();
  });
});
