// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import type {ClientRecord, WifiBand} from '../services/clients.js';
import {createTestI18n} from '@mndw/sdk/testing';
import {useTranslator} from '@mndw/sdk/vue';
import {type App as VueApp, createApp} from 'vue';
import ClientsTable from './ClientsTable.vue';

let host: HTMLElement;
let app: VueApp | null = null;

function makeClient(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    mac: '02:00:00:00:00:01',
    displayName: 'Test client',
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

function mountTable(client: ClientRecord): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ClientsTable, {
    clients: [client],
    columnVisibility: {ip: true, connection: true, uptime: true, lastSeen: true},
    error: null,
    loading: false,
    showOffline: false,
    translator: useTranslator(createTestI18n({
      'column.name': 'Name',
      'column.link': 'Online',
      'column.ip': 'IP Address',
      'column.connection': 'Connection',
      'column.uptime': 'Uptime',
      'column.last-seen': 'Last Seen',
      'empty.found': 'No clients found',
      'empty.connected': 'No clients connected',
      'loading': 'Loading clients…',
      'error': 'show device-list failed',
      'port': 'Port',
      'rssi': 'RSSI',
      'link.online': 'Online',
      'link.offline': 'Offline',
      'link.unavailable': 'Unavailable',
    })),
  });
  app.mount(host);
}

function connectionCell(): HTMLTableCellElement {
  const connectionIndex = [...host.querySelectorAll('thead th')]
    .findIndex((header) => header.textContent?.trim() === 'Connection');
  const row = host.querySelector('tbody tr');
  const cell = row?.querySelectorAll('td')[connectionIndex];

  if (connectionIndex < 0 || cell === undefined) {
    throw new Error('Connection cell was not rendered');
  }

  return cell;
}

function normalizedCellText(cell: HTMLTableCellElement): string {
  return cell.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

describe('name column', () => {
  it('renders the display name through the extracted cell', () => {
    mountTable(makeClient({displayName: 'Alpha client'}));

    const nameCell = host.querySelector('tbody tr td .client-name');

    expect(nameCell?.textContent).toBe('Alpha client');
  });
});

describe('table layout and status semantics', () => {
  it('owns horizontal scrolling in a bounded viewport', () => {
    mountTable(makeClient());

    const viewport = host.querySelector('.mndw-table-viewport');

    expect(viewport).not.toBeNull();
    expect(viewport?.querySelector('table')).not.toBeNull();
    expect(host.querySelector('.mndw-table-controls')).toBeNull();
    expect(host.querySelector('.clients-table')?.parentElement).toBe(viewport);
  });

  it.each([
    ['up' as const, 'Online', 'clients-table__dot--up'],
    ['down' as const, 'Offline', 'clients-table__dot--down'],
    [null, 'Unavailable', 'clients-table__dot--unavailable'],
  ])('renders %s link state as an indicator with accessible text', (link, label, stateClass) => {
    mountTable(makeClient({link}));

    const cell = host.querySelectorAll('tbody td')[1];
    const status = cell?.querySelector('.clients-table__status-indicator');

    expect(status).not.toBeNull();
    expect(status?.querySelector('.clients-table__sr-only')?.textContent).toBe(label);
    expect(status?.classList.contains(stateClass)).toBe(true);
    expect(cell?.textContent?.trim()).toBe(label);
  });

  it('pins first column and keeps duration cells on one line', () => {
    mountTable(makeClient({uptime: 3661, lastSeen: 62}));

    const firstHeader = host.querySelector('thead th');
    const firstCell = host.querySelector('tbody td');

    expect(firstHeader?.classList.contains('clients-table__sticky-column')).toBe(true);
    expect(firstCell?.classList.contains('clients-table__sticky-column')).toBe(true);
    expect(host.querySelector('td.clients-table__nowrap')).not.toBeNull();
    expect(host.querySelectorAll('td.clients-table__nowrap')).toHaveLength(2);
  });
});

describe('connection column', () => {
  it('renders wired speed and port on separate lines', () => {
    mountTable(makeClient({
      connectionType: 'wired',
      connection: {speed: 1000, port: '2'},
    }));

    const cell = connectionCell();

    expect(normalizedCellText(cell)).toBe('1000 Mbps Port 2');
    expect(cell.querySelector('br')).not.toBeNull();
    expect([...host.querySelectorAll('thead th')].map((header) => header.textContent?.trim()))
      .not.toContain('Interface');
    expect([...host.querySelectorAll('thead th')].map((header) => header.textContent?.trim()))
      .not.toContain('Speed');
  });

  it('renders dashes for unusable wired values', () => {
    mountTable(makeClient({
      connectionType: 'wired',
      connection: {speed: null, port: null},
    }));

    const cell = connectionCell();

    expect(normalizedCellText(cell)).toBe('— —');
    expect(cell.querySelector('br')).not.toBeNull();
  });

  it('renders wireless RSSI, rate, and bands', () => {
    mountTable(makeClient({
      connectionType: 'wireless',
      connection: {
        accessPointId: 'WifiMaster1/AccessPoint0',
        bands: ['2'],
        txrate: 866,
        rssi: -42,
        txss: 2,
      },
    }));

    expect(normalizedCellText(connectionCell())).toBe('RSSI: -42; 866 Mbps; 2.4 GHz');
  });

  it.each([
    ['5' as const, '5 GHz'],
    ['6' as const, '6 GHz'],
  ])('keeps %s wireless band display', (band: WifiBand, expected: string) => {
    mountTable(makeClient({
      connectionType: 'wireless',
      connection: {
        accessPointId: 'WifiMaster1/AccessPoint0',
        bands: [band],
        txrate: 866,
        rssi: -42,
        txss: 2,
      },
    }));

    expect(normalizedCellText(connectionCell())).toContain(expected);
  });

  it('renders an offline client as a single dash', () => {
    mountTable(makeClient({active: false, connectionType: 'unknown', connection: null}));

    const cell = connectionCell();

    expect(normalizedCellText(cell)).toBe('—');
    expect(cell.querySelector('br')).toBeNull();
  });
});
