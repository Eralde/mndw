import type {CellRenderer} from '@mndw/ui';
import type {Component} from 'svelte';
import {describe, expectTypeOf, it} from 'vitest';
import {svelteCellWith} from './svelte-cell.svelte.js';

interface TestRow {
  id: string;
  name: string;
}

function fakeComponent<Props extends Record<string, unknown>>(): Component<Props> {
  return () => ({});
}

const withCallback = fakeComponent<{row: TestRow; value: string; colId: string; onPing: () => void}>();
const rowOnly = fakeComponent<{row: TestRow}>();
const withoutExtra = fakeComponent<{row: TestRow; value: string; colId: string}>();
const wrongRow = fakeComponent<{row: string}>();

describe('svelteCellWith types', () => {
  it('builds a renderer when Component props = base + Extra', () => {
    const renderer: () => CellRenderer<TestRow, string> = svelteCellWith<
      TestRow,
      string,
      {onPing: () => void},
      {row: TestRow; value: string; colId: string; onPing: () => void}
    >(
      withCallback,
      (state) => ({onPing: () => void state.row.name}),
    );

    expectTypeOf(renderer).toBeFunction();
  });

  it('accepts an empty Extra with a base-only component', () => {
    const renderer: () => CellRenderer<TestRow, string> = svelteCellWith<
      TestRow,
      string,
      Record<string, never>,
      {row: TestRow}
    >(
      rowOnly,
      () => ({}),
    );

    expectTypeOf(renderer).toBeFunction();
  });

  it('rejects extras missing from the component props', () => {
    svelteCellWith<
      TestRow,
      string,
      {onPing: () => void},
      {row: TestRow; value: string; colId: string}
    >(
      // @ts-expect-error component props do not declare `onPing`
      withoutExtra,
      (state) => ({onPing: () => void state.row.name}),
    );
  });

  it('rejects a component whose base prop type is incompatible', () => {
    svelteCellWith<
      TestRow,
      string,
      Record<string, never>,
      {row: string}
    >(
      // @ts-expect-error component row type does not match the cell row type
      wrongRow,
      () => ({}),
    );
  });

  it('rejects a mapExtra return that omits a declared extra prop', () => {
    const missingExtra = () => ({});

    svelteCellWith<
      TestRow,
      string,
      {onPing: () => void},
      {row: TestRow; value: string; colId: string; onPing: () => void}
    >(
      withCallback,
      // @ts-expect-error mapExtra must return the full Extra shape (`onPing` missing)
      missingExtra,
    );
  });
});
