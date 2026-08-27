// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import type {Column} from '@mndw/ui';
import {type App as VueApp, createApp, nextTick} from 'vue';
import type {ClientRecord} from '../services/clients.js';
import ClientsTable from './ClientsTable.vue';

let host: HTMLElement;
let app: VueApp | null = null;

const translator = createTestI18n({
  'column.name': 'Name',
  'column.ip': 'IP Address',
  'column.connection': 'Connection',
  'column.uptime': 'Uptime',
  'column.last-seen': 'Last Seen',
  'empty.found': 'No clients found',
  'empty.connected': 'No clients connected',
  'loading': 'Loading clients…',
  'error': 'Failed to show device list',
  'link.online': 'Online',
  'link.offline': 'Offline',
  'link.unavailable': 'Unavailable',
  'port': 'Port',
  'rssi': 'RSSI',
});

function client(overrides: Partial<ClientRecord> = {}): ClientRecord {
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

function mount(props: Record<string, unknown> = {}): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ClientsTable, {
    clients: [client()],
    columnVisibility: {ip: true, connection: true, uptime: true, lastSeen: true},
    error: null,
    loading: false,
    showOffline: false,
    translator,
    ...props,
  });
  app.mount(host);
}

type MndwTableEl = HTMLElement & {
  columns: Column<ClientRecord>[];
  rows: ClientRecord[];
  rowKey: string;
  hiddenColumns?: string[];
  columnMenu: boolean;
  updateComplete: Promise<unknown>;
};

function table(): MndwTableEl | null {
  return host.querySelector<HTMLElement>('mndw-table') as MndwTableEl | null;
}

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('ClientsTable', () => {
  it('shows the loading status when loading with no clients', () => {
    mount({clients: [], loading: true});

    expect(host.querySelector('mndw-table')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('Loading clients…');
  });

  it('shows an alert on error', () => {
    mount({clients: [], error: 'boom'});

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('boom');
  });

  it('shows the connected-empty message when no clients and not showing offline', () => {
    mount({clients: []});

    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('No clients connected');
  });

  it('shows the found-empty message when showing offline', () => {
    mount({clients: [], showOffline: true});

    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('No clients found');
  });

  it('renders a table with all columns and the given rows', () => {
    mount();

    const el = table();

    expect(el).not.toBeNull();
    expect(el?.columns.map((column) => column.id))
      .toEqual(['name', 'ip', 'connection', 'uptime', 'lastSeen']);
    expect(el?.rows).toHaveLength(1);
    expect(el?.rowKey).toBe('mac');
    expect(el?.columnMenu).toBe(false);
    expect(el?.hiddenColumns ?? []).toEqual([]);
  });

  it('sizes the table for content width with a floor via attributes', async () => {
    mount();

    const el = table();

    await el?.updateComplete;

    expect(el?.getAttribute('layout')).toBe('auto');
    expect(el?.getAttribute('min-width')).toBe('44rem');
    expect(el?.hasAttribute('sticky-header')).toBe(true);
  });

  it('derives hiddenColumns from columnVisibility', async () => {
    mount({columnVisibility: {ip: false, connection: true, uptime: false, lastSeen: true}});
    await nextTick();

    expect([...(table()?.hiddenColumns ?? [])].sort()).toEqual(['ip', 'uptime']);
  });
});
