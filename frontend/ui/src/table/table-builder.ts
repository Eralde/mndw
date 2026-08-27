import type {Column, ColumnDef} from './table-types.js';

export interface ColumnBuilder<Row> {
  <Value>(def: ColumnDef<Row, Value> & {accessor: (row: Row) => Value}): Column<Row>;
  <Key extends keyof Row>(
    def: ColumnDef<Row, Row[Key]> & ({accessor: Key} | {id: Key; accessor?: undefined}),
  ): Column<Row>;
  (def: ColumnDef<Row, unknown>): Column<Row>;
}

export function column<Row>(): ColumnBuilder<Row> {
  function make<Value>(def: ColumnDef<Row, Value> & {accessor: (row: Row) => Value}): Column<Row>;
  function make<Key extends keyof Row>(
    def: ColumnDef<Row, Row[Key]> & ({accessor: Key} | {id: Key; accessor?: undefined}),
  ): Column<Row>;
  function make(def: ColumnDef<Row, unknown>): Column<Row>;
  function make(def: unknown): Column<Row> {
    return def as Column<Row>;
  }

  return make;
}
