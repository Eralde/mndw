// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import type {ClientRecord, WifiBand} from '../services/clients.js';
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
      connection: {speed: Number.NaN, port: 'undefined'},
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
