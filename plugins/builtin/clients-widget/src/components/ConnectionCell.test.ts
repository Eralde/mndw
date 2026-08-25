// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {vueCell} from '@mndw/ui-vue';
import type {ClientRecord} from '../services/clients.js';
import type {ConnectionView} from './cell-views.js';
import ConnectionCell from './ConnectionCell.vue';

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

function mount(value: ConnectionView): {node: HTMLElement; destroy: () => void} {
  const node = document.createElement('div');

  document.body.appendChild(node);
  parked.push(node);

  const renderer = vueCell<ClientRecord, ConnectionView>()(ConnectionCell)();

  renderer.mount({node, row: row(), value, colId: 'connection'});

  return {node, destroy: () => renderer.destroy()};
}

describe('ConnectionCell through vueCell', () => {
  it('renders a dash for none', () => {
    const {node, destroy} = mount({kind: 'none'});

    expect(node.textContent).toBe('—');
    destroy();
  });

  it('renders a single line for wireless', () => {
    const {node, destroy} = mount({kind: 'wireless', text: 'RSSI: -50; 300 Mbps; 5 GHz'});

    expect(node.textContent).toContain('RSSI: -50; 300 Mbps; 5 GHz');
    expect(node.querySelector('br')).toBeNull();
    destroy();
  });

  it('renders speed over port for wired', () => {
    const {node, destroy} = mount({kind: 'wired', speed: '1000 Mbps', port: 'Port 3'});

    expect(node.querySelector('br')).not.toBeNull();
    expect(node.textContent).toContain('1000 Mbps');
    expect(node.textContent).toContain('Port 3');
    destroy();
  });
});
