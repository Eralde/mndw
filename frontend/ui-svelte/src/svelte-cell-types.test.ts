import type {CellProps, CellRenderer} from '@mndw/ui';
import type {Component} from 'svelte';
import {describe, expectTypeOf, it} from 'vitest';
import {svelteCell} from './svelte-cell.svelte.js';

interface TestRow {
  id: string;
  name: string;
}

type CellPropSet<Row, Value, Props> = CellProps<Row, Value> extends Props ? true : false;

function fakeComponent<Props extends Record<string, unknown>>(): Component<Props> {
  return () => ({});
}

const rowOnly = fakeComponent<{row: TestRow}>();
const full = fakeComponent<{row: TestRow; value: string; colId: string}>();
const extra = fakeComponent<{row: TestRow; value: string; colId: string; extra: string}>();
const wrongRow = fakeComponent<{row: string; value: string; colId: string}>();

describe('svelteCell types', () => {
  it('accepts a row-only component and a full cell component', () => {
    expectTypeOf<CellPropSet<TestRow, string, {row: TestRow}>>().toEqualTypeOf<true>();
    expectTypeOf<CellPropSet<TestRow, string, {row: TestRow; value: string; colId: string}>>().toEqualTypeOf<true>();
  });

  it('rejects extra required props and a wrong row type', () => {
    expectTypeOf<CellPropSet<TestRow, string, {row: TestRow; value: string; colId: string; extra: string}>>()
      .toEqualTypeOf<false>();
    expectTypeOf<CellPropSet<TestRow, string, {row: string; value: string; colId: string}>>().toEqualTypeOf<false>();
  });

  it('builds a renderer for a row-only component', () => {
    const renderer: () => CellRenderer<TestRow, string> = svelteCell<TestRow, string>()(rowOnly);

    expectTypeOf(renderer).toBeFunction();
  });

  it('builds a renderer for a full cell component', () => {
    const renderer: () => CellRenderer<TestRow, string> = svelteCell<TestRow, string>()(full);

    expectTypeOf(renderer).toBeFunction();
  });

  it('rejects an extra required prop and a wrong row type at the call site', () => {
    // @ts-expect-error extra required prop is not satisfiable by the cell context
    svelteCell<TestRow, string>()(extra);
    // @ts-expect-error row must be TestRow
    svelteCell<TestRow, string>()(wrongRow);
  });
});
