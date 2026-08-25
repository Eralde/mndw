// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {vueCell} from '@mndw/ui-vue';
import type {ClientRecord} from '../services/clients.js';
import type {TitledText} from './cell-views.js';
import TitledTextCell from './TitledTextCell.vue';

const parked: HTMLElement[] = [];

afterEach(() => {
  for (const node of parked.splice(0)) {
    node.remove();
  }
});

function row(): ClientRecord {
  return {
    mac: '02:00:00:00:00:01',
    displayName: 'A',
    ip: null,
    link: null,
    active: true,
    connectionType: 'unknown',
    connection: null,
    uptime: null,
    lastSeen: null,
  };
}

describe('TitledTextCell through vueCell', () => {
  it('renders text and title, and omits the title attribute when absent', () => {
    const node = document.createElement('div');

    document.body.appendChild(node);
    parked.push(node);

    const renderer = vueCell<ClientRecord, TitledText>()(TitledTextCell)();

    renderer.mount({node, row: row(), value: {text: '3h', title: '3 hours'}, colId: 'uptime'});

    const withTitle = node.querySelector('span');

    expect(withTitle?.textContent).toBe('3h');
    expect(withTitle?.getAttribute('title')).toBe('3 hours');

    renderer.update({node, row: row(), value: {text: '—'}, colId: 'uptime'});

    const noTitle = node.querySelector('span');

    expect(noTitle?.textContent).toBe('—');
    expect(noTitle?.getAttribute('title')).toBeNull();

    renderer.destroy();
    expect(node.textContent).toBe('');
  });
});
