// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {defineComponents} from '../testing/index.js';
import {MNDW_TABLE_TAG, MndwTable} from './table.js';
import {registerTableMeasurementTarget} from './table-geometry.js';
import {type FakeTableGeometryProvider, createFakeTableGeometryProvider} from './table-test-geometry.js';

defineComponents([MNDW_TABLE_TAG, MndwTable]);

describe('table geometry provider', () => {
  let provider: FakeTableGeometryProvider;

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('accepts declarative row targets and scalar viewport geometry', () => {
    provider = createFakeTableGeometryProvider({
      viewport: {x: 0, y: 0, width: 480, height: 120},
      header: {x: 0, y: 0, width: 480, height: 32},
      rowHeights: new Map([['row-42', {summary: 60, detail: 140}]]),
      defaultSummaryHeight: 37,
      defaultDetailHeight: 160,
      scrollTop: 740,
    });

    const row = document.createElement('tr');
    const detail = document.createElement('tr');
    const header = document.createElement('tr');
    const viewport = document.createElement('div');

    registerTableMeasurementTarget(row, {kind: 'summary', rowKey: 'row-42'});
    registerTableMeasurementTarget(detail, {kind: 'detail', rowKey: 'row-42'});
    registerTableMeasurementTarget(header, {kind: 'header'});
    registerTableMeasurementTarget(viewport, {kind: 'viewport'});

    expect(provider.measure(row).height).toBe(60);
    expect(provider.measure(detail).height).toBe(140);
    expect(provider.measure(header).height).toBe(32);
    expect(provider.measure(viewport).height).toBe(120);
    expect(provider.getViewportScrollTop(viewport)).toBe(740);
    expect(provider.getViewportClientHeight(viewport)).toBe(120);
    expect(provider.getViewportContentWidth(viewport)).toBe(480);
  });

  it('uses defaults for missing row heights and rejects unregistered elements', () => {
    provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 120},
      header: {width: 480, height: 32},
      rowHeights: new Map(),
      defaultSummaryHeight: 37,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });

    const row = document.createElement('tr');

    registerTableMeasurementTarget(row, {kind: 'summary', rowKey: 'missing'});

    expect(provider.measure(row).height).toBe(37);
    expect(() => provider.measure(document.createElement('tr'))).toThrow(/measurement target/);
  });

  it('queues frames and delivers resize callbacks deterministically', () => {
    provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 120},
      header: {width: 480, height: 32},
      rowHeights: new Map(),
      defaultSummaryHeight: 37,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });

    const callback = vi.fn();
    const frame = provider.requestAnimationFrame(callback);

    expect(frame).toBeGreaterThan(0);
    expect(callback).not.toHaveBeenCalled();

    provider.flushFrame();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(provider.cancelAnimationFrame(frame)).toBeUndefined();
  });

  it('injects the provider through direct table construction', async () => {
    provider = createFakeTableGeometryProvider({
      viewport: {x: 0, y: 0, width: 480, height: 120},
      header: {x: 0, y: 0, width: 480, height: 32},
      rowHeights: new Map(),
      defaultSummaryHeight: 37,
      defaultDetailHeight: 160,
      scrollTop: 740,
    });

    const table = new MndwTable(provider);

    document.body.append(table);
    await table.updateComplete;

    expect(table).toBeInstanceOf(MndwTable);
    expect(table.shadowRoot?.querySelectorAll('[part="row"]')).toHaveLength(0);
  });
});
