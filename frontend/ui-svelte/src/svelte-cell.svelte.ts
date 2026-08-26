import {mount, unmount} from 'svelte';
import type {Component} from 'svelte';
import type {CellContext, CellProps, CellRenderer} from '@mndw/ui';

type ExtraPropsOf<Props, Extra> = {
  [Key in keyof Extra]: Key extends keyof Props ? Props[Key] : never;
};

type ComponentPropsConstraint<Row, Value, Extra, Props> = CellProps<Row, Value> & Extra extends Props
  ? Extra extends ExtraPropsOf<Props, Extra> ? unknown : never
  : never;

export function svelteCellWith<
  Row,
  Value,
  Extra extends Record<string, any>,
  Props extends Record<string, any>,
>(
  Component: Component<Props> & ComponentPropsConstraint<Row, Value, Extra, Props>,
  mapExtra: (state: CellProps<Row, Value>) => Extra,
): () => CellRenderer<Row, Value> {
  return () => {
    let node: HTMLElement | undefined;
    let app: ReturnType<typeof mount> | undefined;
    let state: (CellProps<Row, Value> & Extra) | undefined;

    const render = (context: CellContext<Row, Value>): void => {
      if (node === undefined) {
        return;
      }

      if (state === undefined) {
        const created = $state<CellProps<Row, Value>>({
          row: context.row,
          value: context.value,
          colId: context.colId,
        });

        const full = Object.assign(created, mapExtra(created)) as CellProps<Row, Value> & Extra;
        state = full;
        app = mount(Component as Component<CellProps<Row, Value> & Extra>, {
          target: node,
          props: full,
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
}

export function svelteCell<Row, Value = unknown>() {
  return <Props extends Record<string, unknown>>(
    Component: Component<Props> & (CellProps<Row, Value> extends Props ? unknown : never),
  ): () => CellRenderer<Row, Value> => {
    return svelteCellWith<Row, Value, Record<string, never>, CellProps<Row, Value>>(
      Component as Component<CellProps<Row, Value>>,
      () => ({}),
    );
  };
}
