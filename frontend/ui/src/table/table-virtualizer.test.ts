import {describe, expect, it} from 'vitest';
import {TableVirtualizer, type VirtualizerInput, calculateVirtualRange} from './table-virtualizer.js';

function input(overrides: Partial<VirtualizerInput> = {}): VirtualizerInput {
  return {
    keys: ['a', 'b', 'c'],
    expandedKeys: new Set(),
    measurements: new Map(),
    estimatedRowHeight: 50,
    detailEstimate: 160,
    scrollOffset: 55,
    viewportHeight: 50,
    overscan: 0,
    ...overrides,
  };
}

describe('calculateVirtualRange', () => {
  it('returns an empty range for empty input', () => {
    expect(calculateVirtualRange(input({keys: []}))).toEqual({
      start: 0,
      end: 0,
      paddingBefore: 0,
      paddingAfter: 0,
      totalHeight: 0,
    });
  });

  it('renders one row when viewport height is zero', () => {
    const range = calculateVirtualRange(input({scrollOffset: 0, viewportHeight: 0}));

    expect(range.start).toBe(0);
    expect(range.end).toBe(1);
  });

  it('uses fixed row heights and includes the row at the viewport edge', () => {
    expect(calculateVirtualRange(input())).toEqual({
      start: 1,
      end: 3,
      paddingBefore: 50,
      paddingAfter: 0,
      totalHeight: 150,
    });
  });

  it('uses keyed summary and detail measurements', () => {
    const range = calculateVirtualRange(input({
      keys: ['a', 'b'],
      expandedKeys: new Set(['a']),
      measurements: new Map([
        ['a', {summary: 20, detail: 30}],
        ['b', {summary: 80}],
      ]),
      scrollOffset: 0,
      viewportHeight: 25,
    }));

    expect(range.totalHeight).toBe(130);
    expect(range.start).toBe(0);
    expect(range.end).toBe(1);
    expect(range.paddingAfter).toBe(80);
  });
});

describe('TableVirtualizer', () => {
  it('takes over an explicit estimate after four valid summary samples', () => {
    const virtualizer = new TableVirtualizer({estimatedRowHeight: 100, detailEstimate: 160});

    virtualizer.setRows(['a', 'b', 'c', 'd', 'e'], new Set());
    virtualizer.range(0, 100, 0);

    expect(virtualizer.effectiveSummaryEstimate()).toBe(100);

    for (const [key, height] of [['a', 20], ['b', 30], ['c', 40], ['d', 50]] as const) {
      expect(virtualizer.recordSummaryMeasurement(key, height)).toBe(true);
    }

    expect(virtualizer.effectiveSummaryEstimate()).toBe(35);
    expect(virtualizer.range(0, 100, 0).totalHeight).toBe(175);
  });

  it('resets running estimate and measurements at a width epoch', () => {
    const virtualizer = new TableVirtualizer({estimatedRowHeight: 100, detailEstimate: 160});

    virtualizer.setRows(['a', 'b', 'c', 'd', 'e'], new Set());
    virtualizer.range(0, 100, 0);

    for (const [key, height] of [['a', 20], ['b', 30], ['c', 40], ['d', 50]] as const) {
      virtualizer.recordSummaryMeasurement(key, height);
    }

    virtualizer.resetWidthEpoch();

    expect(virtualizer.effectiveSummaryEstimate()).toBe(100);
    expect(virtualizer.range(0, 100, 0).totalHeight).toBe(500);
  });

  it('ignores invalid and sub-pixel-stable measurements', () => {
    const virtualizer = new TableVirtualizer({estimatedRowHeight: 50, detailEstimate: 160});

    virtualizer.setRows(['a'], new Set());

    expect(virtualizer.recordSummaryMeasurement('a', Number.NaN)).toBe(false);
    expect(virtualizer.recordSummaryMeasurement('a', 40)).toBe(true);
    expect(virtualizer.recordSummaryMeasurement('a', 40.1)).toBe(false);
    expect(virtualizer.recordSummaryMeasurement('a', -1)).toBe(false);
  });

  it('calculates anchors and all target alignments', () => {
    const virtualizer = new TableVirtualizer({estimatedRowHeight: 50, detailEstimate: 160});

    virtualizer.setRows(['a', 'b', 'c'], new Set());

    const anchor = virtualizer.captureAnchor(65);

    if (anchor === undefined) {
      throw new Error('expected anchor');
    }

    expect(anchor).toEqual({key: 'b', logicalIndex: 1, intraRowOffset: 15});
    expect(virtualizer.restoreAnchor(anchor, 1000)).toBe(65);
    expect(virtualizer.offsetForRow('c', 'start', 50, 0)).toBe(100);
    expect(virtualizer.offsetForRow('c', 'center', 50, 0)).toBe(100);
    expect(virtualizer.offsetForRow('c', 'end', 50, 0)).toBe(100);
    expect(virtualizer.offsetForRow('a', 'nearest', 50, 25)).toBe(0);
    expect(virtualizer.offsetForRow('c', 'nearest', 50, 25)).toBe(100);
  });

  it('falls back to nearest logical index when anchor key is removed', () => {
    const virtualizer = new TableVirtualizer({estimatedRowHeight: 50, detailEstimate: 160});

    virtualizer.setRows(['a', 'b', 'c'], new Set());

    const anchor = virtualizer.captureAnchor(65);

    virtualizer.setRows(['a', 'c'], new Set());

    if (anchor === undefined) {
      throw new Error('expected anchor');
    }

    expect(virtualizer.restoreAnchor(anchor, 1000)).toBe(65);
  });
});
