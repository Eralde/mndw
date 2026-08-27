import {type Component, type FunctionalComponent, h, render} from 'vue';
import type {CellContext, CellProps, CellRenderer} from '@mndw/ui';

type CellPropsOf<C> = C extends abstract new(...args: never[]) => infer Instance
  ? Instance extends {readonly $props: infer P} ? P
  : never
  : C extends FunctionalComponent<infer P> ? P
  : never;

export function vueCell<Row, Value = unknown>() {
  return <C>(
    Component: C & (CellProps<Row, Value> extends CellPropsOf<C> ? unknown : never),
  ): () => CellRenderer<Row, Value> => {
    return () => {
      let node: HTMLElement | undefined;

      const renderCell = (context: CellContext<Row, Value>): void => {
        if (node === undefined) {
          throw new Error('Cannot update a cell renderer before mount');
        }

        const props: CellProps<Row, Value> = {
          row: context.row,
          value: context.value,
          colId: context.colId,
        };

        render(h(Component as Component, props), node);
      };

      return {
        mount(context) {
          node = context.node;
          renderCell(context);
        },
        update(context) {
          renderCell(context);
        },
        destroy() {
          if (node !== undefined) {
            render(null, node);
            node = undefined;
          }
        },
      };
    };
  };
}
