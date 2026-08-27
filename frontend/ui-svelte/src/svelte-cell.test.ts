import type {CellRenderer} from '@mndw/ui';
import {compileModule} from 'svelte/compiler';
import {flushSync} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import TestCell from './fixtures/TestCell.svelte';
import {svelteCell} from './svelte-cell.svelte.js';

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

function rendererFactory(): () => CellRenderer<TestRow, string> {
  return svelteCell<TestRow, string>()(TestCell);
}

describe('svelte-cell.svelte.ts rune diagnostics', () => {
  it('compiles the adapter rune pattern without state_invalid_placement diagnostics', () => {
    const probe = `
      export function makeCell() {
        return () => {
          let state;
          const render = (row, value, colId) => {
            if (state === undefined) {
              const created = $state({row, value, colId});
              state = created;
              return created;
            }
            state.row = row;
            state.value = value;
            state.colId = colId;
            return state;
          };
          return {render};
        };
      }
    `;

    const result = compileModule(probe, {filename: 'svelte-cell.svelte.ts', generate: 'client'});

    expect(result.warnings.filter((warning) => warning.code === 'state_invalid_placement')).toHaveLength(0);
  });

  it('still flags an invalid $state placement as state_invalid_placement', () => {
    expect(() => compileModule('let x = 1; x = $state(2);', {filename: 'probe.svelte.ts', generate: 'client'})).toThrow(
      /state_invalid_placement/,
    );
  });
});

describe('svelteCell runtime', () => {
  it('mounts into a parked node and renders the initial props', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'alpha', colId: 'name'});

    expect(node.textContent).toBe('alpha Alpha');
  });

  it('updates reactively in place when row, value, and colId change', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'alpha', colId: 'name'});

    const span = node.querySelector('span.test-cell');
    const strong = node.querySelector('strong');

    renderer.update({node, row: {name: 'Beta'}, value: 'beta', colId: 'name'});
    flushSync();

    expect(node.querySelector('span.test-cell')).toBe(span);
    expect(node.querySelector('strong')).toBe(strong);
    expect(node.textContent).toBe('beta Beta');
  });

  it('reaches the light-DOM host with the scoped style class', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'alpha', colId: 'name'});

    const span = node.querySelector('span.test-cell');

    expect(span?.className).toContain('svelte-');
  });

  it('destroys and unmounts the component from the parked node', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'alpha', colId: 'name'});
    renderer.destroy();

    expect(node.textContent).toBe('');
  });
});
