// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {vueCell} from '@mndw/ui-vue';
import type {ClientRecord} from '../services/clients.js';
import type {ConnectionView, WirelessConnectionView} from './cell-views.js';
import type {RssiQuality} from './rssi.js';
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

function wireless(overrides: Partial<WirelessConnectionView> = {}): WirelessConnectionView {
  return {
    kind: 'wireless',
    label: 'RSSI',
    rssi: '-50',
    rate: '300 Mbps',
    quality: 'good',
    title: 'Signal: good',
    ...overrides,
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

function rssiSpan(node: HTMLElement): HTMLElement {
  const span = node.querySelector<HTMLElement>('.connection-cell__rssi');

  if (span === null) {
    throw new Error('RSSI value was not rendered');
  }

  return span;
}

describe('ConnectionCell through vueCell', () => {
  it('renders a dash for none', () => {
    const {node, destroy} = mount({kind: 'none'});

    expect(node.textContent).toBe('—');
    destroy();
  });

  it('renders the wireless line on one line, keeping the text format', () => {
    const {node, destroy} = mount(wireless());
    const text = node.textContent?.replace(/\s+/g, ' ').trim();

    expect(text).toBe('RSSI: -50; 300 Mbps');
    expect(node.querySelector('br')).toBeNull();
    destroy();
  });

  it.each(
    [
      ['good', 'connection-cell__rssi--good', 'Signal: good'],
      ['fair', 'connection-cell__rssi--fair', 'Signal: fair'],
      ['weak', 'connection-cell__rssi--weak', 'Signal: weak'],
    ] as const,
  )('colours a %s RSSI and names the level in its title', (quality: RssiQuality, className, title) => {
    const {node, destroy} = mount(wireless({quality, title}));
    const span = rssiSpan(node);

    expect(span.classList.contains(className)).toBe(true);
    expect(span.getAttribute('title')).toBe(title);
    destroy();
  });

  it('renders an unknown RSSI without colour or title', () => {
    const {node, destroy} = mount(wireless({rssi: '—', quality: 'unknown', title: undefined}));
    const span = rssiSpan(node);

    expect(span.classList).toHaveLength(1);
    expect(span.hasAttribute('title')).toBe(false);
    expect(node.textContent?.replace(/\s+/g, ' ').trim()).toBe('RSSI: —; 300 Mbps');
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
