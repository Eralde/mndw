// @vitest-environment happy-dom
import {expect, it} from 'vitest';
import {
  DETAIL_COL_ID,
  MNDW_ROW_EXPAND_EVENT,
  type MndwRowExpandDetail,
  type MndwTableProps,
  type ScrollToRowOptions,
} from './table-types.js';

it('exposes expandable table API types and constants', () => {
  expect(MNDW_ROW_EXPAND_EVENT).toBe('mndwrowexpand');
  expect(DETAIL_COL_ID).toBe('__mndw_detail__');

  const detail: MndwRowExpandDetail = {expanded: ['a']};
  const props: MndwTableProps<{id: string}> = {
    columns: [],
    rows: [],
    rowKey: 'id',
    expandable: true,
    expandOn: 'row',
    toggleCell: 'trailing',
    toggleAfterColumn: 'id',
    expanded: ['a'],
    expandedRenderer: () => ({mount() {}, update() {}, destroy() {}}),
    virtual: true,
    estimatedRowHeight: 42,
    overscan: 0,
  };
  const scrollOptions: ScrollToRowOptions = {align: 'nearest'};

  expect(props.expandable).toBe(true);
  expect(detail.expanded).toEqual(['a']);
  expect(props.virtual).toBe(true);
  expect(scrollOptions.align).toBe('nearest');
});
