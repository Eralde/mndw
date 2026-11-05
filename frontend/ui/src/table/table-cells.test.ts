// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CellRegistry} from './table-cells.js';
import {type CellRenderer, type Column, DETAIL_COL_ID} from './table-types.js';

interface Row {
  id: string;
  name: string;
}

interface SpyRenderer extends CellRenderer<Row> {
  mount: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function createSpyRenderer(): SpyRenderer {
  return {
    mount: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
  };
}

function rendererColumn(id: string, factory: () => CellRenderer<Row>): Column<Row> {
  return {id, label: id, renderer: factory};
}

const keyOf = (row: Row) => row.id;
const readName = (_column: Column<Row>, row: Row) => row.name;

describe('CellRegistry', () => {
  let host: HTMLElement;
  let registry: CellRegistry<Row>;

  afterEach(() => {
    host.remove();
  });

  beforeEach(() => {
    host = document.createElement('div');
    registry = new CellRegistry<Row>(host);
  });

  it('mounts each custom cell once and updates on same-key replacement', () => {
    const renderer = createSpyRenderer();
    const column = rendererColumn('name', () => renderer);
    const rows = [{id: 'a', name: 'A'}];

    registry.reconcile(rows, keyOf, [column], new Set(['name']), readName);

    expect(renderer.mount).toHaveBeenCalledTimes(1);

    const replaced = [{id: 'a', name: 'A2'}];

    registry.reconcile(replaced, keyOf, [column], new Set(['name']), readName);

    expect(renderer.mount).toHaveBeenCalledTimes(1);
    expect(renderer.update).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).not.toHaveBeenCalled();
    expect(renderer.update).toHaveBeenCalledWith(expect.objectContaining({value: 'A2'}));
  });

  it('destroys and remounts when the renderer factory identity changes', () => {
    const first = createSpyRenderer();
    const second = createSpyRenderer();
    const rows = [{id: 'a', name: 'A'}];

    registry.reconcile(rows, keyOf, [rendererColumn('name', () => first)], new Set(['name']), readName);
    registry.reconcile(rows, keyOf, [rendererColumn('name', () => second)], new Set(['name']), readName);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.mount).toHaveBeenCalledTimes(1);
  });

  it('destroys and remounts when the row key changes', () => {
    const renderer = createSpyRenderer();
    const column = rendererColumn('name', () => renderer);

    registry.reconcile([{id: 'a', name: 'A'}], keyOf, [column], new Set(['name']), readName);
    registry.reconcile([{id: 'b', name: 'B'}], keyOf, [column], new Set(['name']), readName);

    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    expect(renderer.mount).toHaveBeenCalledTimes(2);
  });

  it('destroys on row removal', () => {
    const renderer = createSpyRenderer();
    const column = rendererColumn('name', () => renderer);

    registry.reconcile([{id: 'a', name: 'A'}], keyOf, [column], new Set(['name']), readName);
    registry.reconcile([], keyOf, [column], new Set(['name']), readName);

    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys on column hide', () => {
    const renderer = createSpyRenderer();
    const column = rendererColumn('name', () => renderer);

    registry.reconcile([{id: 'a', name: 'A'}], keyOf, [column], new Set(['name']), readName);
    registry.reconcile([{id: 'a', name: 'A'}], keyOf, [column], new Set(), readName);

    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('allocates unique opaque slot ids and never collides', () => {
    const columnA = rendererColumn('a:b', () => createSpyRenderer());
    const columnB = rendererColumn('b:c', () => createSpyRenderer());
    const rows = [{id: 'a:b', name: 'x'}, {id: 'a/b', name: 'y'}];
    const columns = [columnA, columnB];

    registry.reconcile(rows, keyOf, columns, new Set(['a:b', 'b:c']), readName);

    const slots = host.querySelectorAll('[slot]');

    expect(slots).toHaveLength(4);
    expect(new Set([...slots].map((node) => node.getAttribute('slot'))).size).toBe(4);
  });

  it('re-projects a reordered entry without remounting', () => {
    const renderer = createSpyRenderer();
    const column = rendererColumn('name', () => renderer);

    registry.reconcile([{id: 'a', name: 'A'}, {id: 'b', name: 'B'}], keyOf, [column], new Set(['name']), readName);
    registry.reconcile([{id: 'b', name: 'B'}, {id: 'a', name: 'A'}], keyOf, [column], new Set(['name']), readName);

    expect(renderer.mount).toHaveBeenCalledTimes(2);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });

  it('drains every entry and removes every parked node', () => {
    const column = rendererColumn('name', () => createSpyRenderer());

    registry.reconcile([{id: 'a', name: 'A'}, {id: 'b', name: 'B'}], keyOf, [column], new Set(['name']), readName);
    registry.drain();

    expect(host.querySelectorAll('[slot]')).toHaveLength(0);
  });

  it('mounts, updates, and prunes a detail renderer for expanded rows', () => {
    const detail = createSpyRenderer();
    const rows = [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}];
    const detailFactory = () => detail;
    const readValue = () => undefined;

    registry.reconcile(rows, keyOf, [], new Set(['a']), readValue, new Set(['a']), detailFactory);
    expect(detail.mount).toHaveBeenCalledTimes(1);
    expect(registry.getSlotId('a', DETAIL_COL_ID)).toBeDefined();

    registry.reconcile(rows, keyOf, [], new Set(['a']), readValue, new Set(['a']), detailFactory);
    expect(detail.mount).toHaveBeenCalledTimes(1);
    expect(detail.update).toHaveBeenCalledTimes(1);

    registry.reconcile(rows, keyOf, [], new Set(['a']), readValue, new Set(), detailFactory);
    expect(detail.destroy).toHaveBeenCalledTimes(1);
    expect(registry.getSlotId('a', DETAIL_COL_ID)).toBeUndefined();
  });

  it('resolves a parked custom-cell node to its owning row key', () => {
    const renderer = createSpyRenderer();
    const column = rendererColumn('name', () => renderer);

    registry.reconcile([{id: 'a', name: 'A'}], keyOf, [column], new Set(['name']), readName);

    const parkedNode = host.querySelector('[slot]');

    expect(parkedNode).not.toBeNull();
    expect(registry.getRowKeyForNode(parkedNode as Node)).toBe('a');
    expect(registry.getRowKeyForNode(document.createElement('div'))).toBeUndefined();
  });
});
