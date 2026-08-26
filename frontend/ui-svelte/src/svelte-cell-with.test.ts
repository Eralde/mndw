import type {CellRenderer} from '@mndw/ui';
import {type ComponentProps, flushSync} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import ExtraCell from './fixtures/ExtraCell.svelte';
import {svelteCellWith} from './svelte-cell.svelte.js';

interface TestRow {
  name: string;
}

const parkedNodes: HTMLElement[] = [];

afterEach(() => {
  for (const node of parkedNodes.splice(0)) {
    node.remove();
  }
});

function parkedNode(): HTMLDivElement {
  const node = document.createElement('div');

  document.body.appendChild(node);
  parkedNodes.push(node);

  return node;
}

function factory(
  onPing: (name: string) => void,
  onMapExtra: () => void = () => {},
): () => CellRenderer<TestRow, string> {
  return svelteCellWith<
    TestRow,
    string,
    {label: string; onPing: () => void},
    ComponentProps<typeof ExtraCell>
  >(
    ExtraCell,
    (state) => {
      onMapExtra();

      return {
        label: 'L',
        onPing: () => onPing(state.row.name),
      };
    },
  );
}

describe('svelteCellWith', () => {
  it('mounts once with base props and extras merged in', () => {
    const renderer = factory(() => {})();
    const node = parkedNode();

    renderer.mount({node, row: {name: 'alpha'}, value: 'v1', colId: 'c'});
    flushSync();

    const button = node.querySelector('.extra-cell');

    expect(button?.textContent).toBe('L:v1:alpha');
    expect(button?.getAttribute('data-col')).toBe('c');
  });

  it('runs the callback against the current row after an update', () => {
    const onPing = vi.fn();
    const renderer = factory(onPing)();
    const node = parkedNode();

    renderer.mount({node, row: {name: 'alpha'}, value: 'v1', colId: 'c'});
    flushSync();
    renderer.update({node, row: {name: 'beta'}, value: 'v2', colId: 'next'});
    flushSync();

    node.querySelector<HTMLButtonElement>('.extra-cell')?.click();
    expect(onPing).toHaveBeenCalledWith('beta');
  });

  it('syncs base props on update without remounting', () => {
    const onMapExtra = vi.fn();
    const renderer = factory(() => {}, onMapExtra)();
    const node = parkedNode();

    renderer.mount({node, row: {name: 'alpha'}, value: 'v1', colId: 'c'});
    flushSync();

    const first = node.querySelector('.extra-cell');

    renderer.update({node, row: {name: 'beta'}, value: 'v2', colId: 'next'});
    flushSync();

    const second = node.querySelector('.extra-cell');

    expect(second).toBe(first);
    expect(second?.textContent).toBe('L:v2:beta');
    expect(second?.getAttribute('data-col')).toBe('next');
    expect(onMapExtra).toHaveBeenCalledTimes(1);
  });

  it('unmounts on destroy', () => {
    const renderer = factory(() => {})();
    const node = parkedNode();

    renderer.mount({node, row: {name: 'alpha'}, value: 'v1', colId: 'c'});
    flushSync();
    renderer.destroy();
    flushSync();

    expect(node.querySelector('.extra-cell')).toBeNull();
  });

  it('ignores update when called before mount', () => {
    const renderer = factory(() => {})();

    expect(() => renderer.update({node: parkedNode(), row: {name: 'x'}, value: 'v', colId: 'c'})).not.toThrow();
  });
});
