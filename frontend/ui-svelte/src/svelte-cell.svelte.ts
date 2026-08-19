import {mount, unmount} from 'svelte';
import type {Component} from 'svelte';
import type {CellContext, CellProps, CellRenderer} from '@mndw/ui';

export function svelteCell<Row, Value = unknown>() {
  return <Props extends Record<string, unknown>>(
    Component: Component<Props> & (CellProps<Row, Value> extends Props ? unknown : never),
  ): () => CellRenderer<Row, Value> => {
    return () => {
      let node: HTMLElement | undefined;
      let app: ReturnType<typeof mount> | undefined;
      let state: CellProps<Row, Value> | undefined;

      const render = (context: CellContext<Row, Value>): void => {
        if (node === undefined) {
          throw new Error('Cannot update a cell renderer before mount');
        }

        if (state === undefined) {
          const created = $state<CellProps<Row, Value>>({
            row: context.row,
            value: context.value,
            colId: context.colId,
          });

          state = created;
          app = mount(Component as Component<CellProps<Row, Value>>, {
            target: node,
            props: state,
          });
          return;
        }

        state.row = context.row;
        state.value = context.value;
        state.colId = context.colId;
      };

      return {
        mount(context) {
          node = context.node;
          render(context);
        },
        update(context) {
          render(context);
        },
        destroy() {
          if (app !== undefined) {
            unmount(app);
            app = undefined;
          }
          node = undefined;
          state = undefined;
        },
      };
    };
  };
}
