import type {CellProps, CellRenderer} from '@mndw/ui';
import {type FunctionalComponent, type PropType, defineComponent, h} from 'vue';
import {describe, expectTypeOf, it} from 'vitest';
import {vueCell} from './vue-cell.js';

interface TestRow {
  id: string;
  name: string;
}

type CellPropSet<Row, Value, Props> = CellProps<Row, Value> extends Props ? true : false;

const rowOnly = defineComponent({props: {row: Object as PropType<TestRow>}});
const extra = defineComponent({
  props: {row: Object as PropType<TestRow>, value: String, colId: String, extra: {type: String, required: true}},
});
const wrongRow = defineComponent({props: {row: String, value: String, colId: String}});
const functional = ((props: {row: TestRow}) => h('span', props.row.name)) as FunctionalComponent<{row: TestRow}>;

describe('vueCell types', () => {
  it('extracts declared props from constructible components', () => {
    expectTypeOf<CellPropSet<TestRow, string, {row?: TestRow}>>().toEqualTypeOf<true>();
    expectTypeOf<CellPropSet<TestRow, string, {row?: TestRow; value?: string; colId?: string}>>().toEqualTypeOf<true>();
  });

  it('rejects an extra required prop and a wrong row type', () => {
    expectTypeOf<CellPropSet<TestRow, string, {row?: TestRow; value?: string; colId?: string; extra: string}>>()
      .toEqualTypeOf<false>();
    expectTypeOf<CellPropSet<TestRow, string, {row?: string; value?: string; colId?: string}>>().toEqualTypeOf<false>();
  });

  it('accepts a declared-props component', () => {
    const renderer: () => CellRenderer<TestRow, string> = vueCell<TestRow, string>()(rowOnly);

    expectTypeOf(renderer).toBeFunction();
  });

  it('accepts a functional component', () => {
    const renderer: () => CellRenderer<TestRow, string> = vueCell<TestRow, string>()(functional);

    expectTypeOf(renderer).toBeFunction();
  });

  it('rejects an extra required prop and a wrong row type at the call site', () => {
    // @ts-expect-error extra required prop is not satisfiable by the cell context
    vueCell<TestRow, string>()(extra);
    // @ts-expect-error row must be TestRow
    vueCell<TestRow, string>()(wrongRow);
  });
});
