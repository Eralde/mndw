import type {CellRenderer} from '@mndw/ui';
import {compileModule} from 'svelte/compiler';
import {flushSync} from 'svelte';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import StatefulCell from './fixtures/StatefulCell.svelte';
import TestCell from './fixtures/TestCell.svelte';
import {svelteCellLifecycle} from './fixtures/stateful-cell-lifecycle.js';
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

beforeEach(() => {
  svelteCellLifecycle.created = 0;
  svelteCellLifecycle.mounted = 0;
  svelteCellLifecycle.destroyed = 0;
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

describe('svelteCell stateful lifecycle', () => {
  it('keeps local state and component instance across update', () => {
    const node = parkedNode();
    const renderer = svelteCell<{id: string; name: string}, string>()(StatefulCell)();
    const row = {id: 'a', name: 'Alpha'};

    renderer.mount({node, row, value: 'alpha', colId: 'name'});

    const button = node.querySelector<HTMLButtonElement>('.stateful-cell');

    button?.click();
    flushSync();

    renderer.update({node, row: {...row, name: 'Alpha updated'}, value: 'updated', colId: 'name'});
    flushSync();

    expect(node.querySelector('.stateful-cell')).toBe(button);
    expect(node.textContent).toBe('1|updated|Alpha updated|name');
    expect(svelteCellLifecycle.created).toBe(1);
    expect(svelteCellLifecycle.mounted).toBe(1);

    renderer.destroy();
  });

  it('destroys exactly once and remounts with fresh local state', () => {
    const node = parkedNode();
    const renderer = svelteCell<{id: string; name: string}, string>()(StatefulCell)();
    const row = {id: 'a', name: 'Alpha'};

    renderer.mount({node, row, value: 'alpha', colId: 'name'});
    node.querySelector<HTMLButtonElement>('.stateful-cell')?.click();
    flushSync();
    renderer.destroy();
    renderer.destroy();

    expect(svelteCellLifecycle.destroyed).toBe(1);
    expect(node.textContent).toBe('');

    renderer.mount({node, row, value: 'remounted', colId: 'name'});
    flushSync();

    expect(node.textContent).toBe('0|remounted|Alpha|name');
    expect(svelteCellLifecycle.created).toBe(2);
    expect(svelteCellLifecycle.mounted).toBe(2);

    renderer.destroy();

    expect(svelteCellLifecycle.destroyed).toBe(2);
  });
});
