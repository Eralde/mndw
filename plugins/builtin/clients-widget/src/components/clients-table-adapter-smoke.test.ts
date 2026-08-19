// @vitest-environment happy-dom
import {vueCell} from '@mndw/ui-vue';
import {afterEach, describe, expect, it} from 'vitest';
import type {ClientRecord} from '../services/clients.js';
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
  it('renders, updates on fresh VNodes, and destroys without leaking cell props', () => {
    const node = document.createElement('div');

    document.body.appendChild(node);
    parkedNodes.push(node);

    const renderer = vueCell<ClientRecord, string>()(ClientNameCell)();

    renderer.mount({node, row: record(), value: 'Alpha', colId: 'name'});
    expect(node.querySelector('span.client-name')?.textContent).toBe('Alpha');

    renderer.update({node, row: record({displayName: 'Beta'}), value: 'Beta', colId: 'name'});

    const span = node.querySelector('span.client-name');

    expect(span?.textContent).toBe('Beta');
    expect(span?.getAttribute('row')).toBeNull();
    expect(span?.getAttribute('value')).toBeNull();
    expect(span?.getAttribute('col-id')).toBeNull();

    renderer.destroy();
    expect(node.textContent).toBe('');
  });
});
