import type {CellRenderer} from '@mndw/ui';
import * as vue from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import TestCell from './fixtures/TestCell.vue';
import {vueCell} from './vue-cell.js';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();

  return {...actual, render: vi.fn(actual.render)};
});

interface TestRow {
  name: string;
}

const DeclaredCell = vue.defineComponent({
  props: {
    row: {type: Object as vue.PropType<TestRow>, required: true},
    value: String,
    colId: String,
  },
  setup(props) {
    return () => vue.h('span', {class: 'declared-cell'}, `${props.value}|${props.row.name}|${props.colId}`);
  },
});

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
  return vueCell<TestRow, string>()(DeclaredCell);
}

describe('vueCell runtime', () => {
  it('mounts into a parked node and renders declared props', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'a', colId: 'name'});

    expect(node.textContent).toBe('a|Alpha|name');
  });

  it('updates the DOM with a fresh VNode on same-key changes', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'a', colId: 'name'});
    renderer.update({node, row: {name: 'Beta'}, value: 'b', colId: 'name'});

    expect(node.textContent).toBe('b|Beta|name');
  });

  it('copies the context into a fresh props object so stale references do not re-render', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();
    const ctx = {node, row: {name: 'Alpha'} as TestRow, value: 'a', colId: 'name'};

    renderer.mount(ctx);
    ctx.value = 'mutated';

    expect(node.textContent).toBe('a|Alpha|name');
  });

  it('destroys by rendering null into the parked node', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();
    const renderMock = vi.mocked(vue.render);

    renderer.mount({node, row: {name: 'Alpha'}, value: 'a', colId: 'name'});
    renderMock.mockClear();
    renderer.destroy();

    expect(renderMock).toHaveBeenCalledWith(null, node);
    expect(node.textContent).toBe('');
  });

  it('renders a scoped-style component into the light-DOM host', () => {
    const node = parkedNode();
    const renderer = vueCell<TestRow, string>()(TestCell)();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'a', colId: 'name'});

    const span = node.querySelector('span.vue-cell');

    expect(span?.textContent).toBe('a Alpha');
    expect([...(span?.attributes ?? [])].some((attribute) => attribute.name.startsWith('data-v-'))).toBe(true);
  });

  it('does not leak declared cell props as attributes on the root', () => {
    const node = parkedNode();
    const renderer = rendererFactory()();

    renderer.mount({node, row: {name: 'Alpha'}, value: 'a', colId: 'name'});

    const span = node.querySelector('.declared-cell');

    expect(span?.getAttribute('row')).toBeNull();
    expect(span?.getAttribute('value')).toBeNull();
    expect(span?.getAttribute('colId')).toBeNull();
  });
});
