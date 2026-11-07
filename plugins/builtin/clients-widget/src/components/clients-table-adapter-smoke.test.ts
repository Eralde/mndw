// @vitest-environment happy-dom
import {vueCell} from '@mndw/ui-vue';
import {afterEach, describe, expect, it} from 'vitest';
import type {ClientRecord} from '../services/clients.js';
import type {ClientNameView} from './cell-views.js';
import ClientNameCell from './ClientNameCell.vue';

function record(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    mac: '02:00:00:00:00:01',
    displayName: 'Alpha',
    ip: '192.168.1.2',
    link: 'up',
    active: true,
    connectionType: 'unknown',
    connection: null,
    uptime: null,
    lastSeen: null,
    ...overrides,
  };
}

const parkedNodes: HTMLElement[] = [];

afterEach(() => {
  for (const node of parkedNodes.splice(0)) {
    node.remove();
  }
});

describe('ClientNameCell through vueCell', () => {
  it('keeps the status indicator round without shrinking', () => {
    const node = document.createElement('div');

    document.body.appendChild(node);
    parkedNodes.push(node);

    const renderer = vueCell<ClientRecord, ClientNameView>()(ClientNameCell)();

    renderer.mount({
      node,
      row: record({displayName: 'A very long client name that would otherwise squeeze the status dot'}),
      value: {
        displayName: 'A very long client name that would otherwise squeeze the status dot',
        link: {tone: 'up', label: 'Online'},
      },
      colId: 'name',
    });

    const indicator = node.querySelector<HTMLElement>('.clients-table__status-indicator');
    const style = indicator === null ? null : getComputedStyle(indicator);

    expect(style?.flexShrink).toBe('0');
    expect(style?.width).toBe(style?.height);

    renderer.destroy();
  });

  it('renders, updates on fresh VNodes, and destroys without leaking cell props', () => {
    const node = document.createElement('div');

    document.body.appendChild(node);
    parkedNodes.push(node);

    const renderer = vueCell<ClientRecord, ClientNameView>()(ClientNameCell)();

    renderer.mount({
      node,
      row: record(),
      value: {displayName: 'Alpha', link: {tone: 'up', label: 'Online'}},
      colId: 'name',
    });

    const initialCell = node.querySelector('.client-name-cell');

    expect(initialCell?.firstElementChild?.classList.contains('clients-table__status-indicator')).toBe(true);
    expect(node.querySelector('span.client-name')?.textContent).toBe('Alpha');

    renderer.update({
      node,
      row: record({displayName: 'Beta', link: 'down'}),
      value: {displayName: 'Beta', link: {tone: 'down', label: 'Offline'}},
      colId: 'name',
    });

    const span = node.querySelector('span.client-name');

    expect(span?.textContent).toBe('Beta');
    expect(node.querySelector('.clients-table__dot--down')).not.toBeNull();
    expect(span?.getAttribute('row')).toBeNull();
    expect(span?.getAttribute('value')).toBeNull();
    expect(span?.getAttribute('col-id')).toBeNull();

    renderer.destroy();
    expect(node.textContent).toBe('');
  });
});
