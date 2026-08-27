import {describe, expectTypeOf, it} from 'vitest';
import {column} from './table-builder.js';
import type {CellRenderer, Column, RowKey} from './table-types.js';

interface MwsNode {
  name: string;
  ip: string;
  clients: number;
}

interface NodeRow {
  id: string;
  node: MwsNode;
}

const make = column<NodeRow>();

describe('column builder', () => {
  it('infers Value from a function accessor', () => {
    const col = make({
      id: 'name',
      label: 'Name',
      accessor: (row) => row.node.name,
      comparator: (a, b) => {
        expectTypeOf(a).toEqualTypeOf<string>();
        expectTypeOf(b).toEqualTypeOf<string>();

        return a.localeCompare(b);
      },
    });

    expectTypeOf(col).toEqualTypeOf<Column<NodeRow>>();
  });

  it('infers Value from a keyof accessor', () => {
    const col = make({id: 'node', label: 'Node', accessor: 'node'});

    expectTypeOf(col).toEqualTypeOf<Column<NodeRow>>();
  });

  it('infers Value from an omitted accessor whose id is a key of Row', () => {
    const col = make({
      id: 'id',
      label: 'Id',
      comparator: (a, b) => {
        expectTypeOf(a).toEqualTypeOf<string>();
        expectTypeOf(b).toEqualTypeOf<string>();

        return a.localeCompare(b);
      },
    });

    expectTypeOf(col).toEqualTypeOf<Column<NodeRow>>();
  });

  it('types badge and renderer callbacks against the resolved Value', () => {
    make({
      id: 'clients',
      label: 'Clients',
      accessor: (row) => row.node.clients,
      badge: (value) => {
        expectTypeOf(value).toEqualTypeOf<number>();

        return {text: String(value), tone: 'info'};
      },
    });

    make({
      id: 'name',
      label: 'Name',
      accessor: (row) => row.node.name,
      renderer: (): CellRenderer<NodeRow, string> => ({
        mount: (ctx) => {
          expectTypeOf(ctx.value).toEqualTypeOf<string>();
        },
        update: (ctx) => {
          expectTypeOf(ctx.row).toEqualTypeOf<NodeRow>();
        },
        destroy: () => {},
      }),
    });
  });

  it('rejects a mismatched comparator', () => {
    // @ts-expect-error comparator must operate over the accessor Value (string)
    make({id: 'name', label: 'Name', accessor: (row) => row.node.name, comparator: (a: number, b: number) => a - b});
  });

  it('rejects a mismatched badge value', () => {
    make({
      id: 'clients',
      label: 'Clients',
      accessor: (row) => row.node.clients,
      // @ts-expect-error badge must consume the accessor Value (number)
      badge: (value: string) => ({text: value, tone: 'info'}),
    });
  });

  it('rejects a mismatched renderer value', () => {
    make({
      id: 'name',
      label: 'Name',
      accessor: (row) => row.node.name,
      // @ts-expect-error renderer must agree with the accessor Value (string)
      renderer: (): CellRenderer<NodeRow, number> => ({
        mount: () => {},
        update: () => {},
        destroy: () => {},
      }),
    });
  });

  it('rejects an invalid accessor key', () => {
    // @ts-expect-error 'missing' is not a key of NodeRow
    make({id: 'name', label: 'Name', accessor: 'missing'});
  });

  it('rejects a non-string rowKey field', () => {
    const acceptRowKey = (_key: RowKey<NodeRow>): void => {};

    // @ts-expect-error 'node' resolves to MwsNode, not a string-valued field
    acceptRowKey('node');
  });
});
