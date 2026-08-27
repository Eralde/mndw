// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {createTestI18n} from '@mndw/sdk/testing';
import type {ClientRecord, WirelessConnectionInfo} from '../services/clients.js';
import {formatCompactDuration, formatElapsed, formatFullDuration} from '../services/format-duration.js';
import type {ClientNameView, ConnectionView, TitledText} from './cell-views.js';
import {buildColumns} from './columns.js';

const translator = createTestI18n({
  'column.name': 'Name',
  'column.ip': 'IP Address',
  'column.connection': 'Connection',
  'column.uptime': 'Uptime',
  'column.last-seen': 'Last Seen',
  'link.online': 'Online',
  'link.offline': 'Offline',
  'link.unavailable': 'Unavailable',
  'rssi': 'RSSI',
  'port': 'Port',
});

function client(overrides: Partial<ClientRecord> = {}): ClientRecord {
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

function accessorOf(id: string): (row: ClientRecord) => unknown {
  const col = buildColumns(translator).find((candidate) => candidate.id === id);

  if (col === undefined || typeof col.accessor !== 'function') {
    throw new Error(`no function accessor for ${id}`);
  }

  return col.accessor as (row: ClientRecord) => unknown;
}

describe('buildColumns', () => {
  it('produces the expected column ids in order', () => {
    expect(buildColumns(translator).map((column) => column.id))
      .toEqual(['name', 'ip', 'connection', 'uptime', 'lastSeen']);
  });

  it('marks only ip/connection/uptime/lastSeen hideable; name explicitly not', () => {
    const byId = new Map(buildColumns(translator).map((column) => [column.id, column.hideable]));

    expect(byId.get('name')).toBe(false);
    expect([byId.get('ip'), byId.get('connection'), byId.get('uptime'), byId.get('lastSeen')])
      .toEqual([true, true, true, true]);
  });

  it('pins the name column and marks uptime/lastSeen nowrap', () => {
    const byId = new Map(buildColumns(translator).map((column) => [column.id, column]));

    expect(byId.get('name')?.sticky).toBe('start');
    expect(byId.get('name')?.width).toBe('12rem');
    expect(byId.get('uptime')?.nowrap).toBe(true);
    expect(byId.get('lastSeen')?.nowrap).toBe(true);
  });

  it('name accessor places the client name beside its three-state activity view', () => {
    expect(accessorOf('name')(client({link: 'up'})))
      .toEqual({displayName: 'Alpha', link: {tone: 'up', label: 'Online'}} satisfies ClientNameView);
    expect(accessorOf('name')(client({link: 'down'})))
      .toEqual({displayName: 'Alpha', link: {tone: 'down', label: 'Offline'}} satisfies ClientNameView);
    expect(accessorOf('name')(client({link: null})))
      .toEqual({displayName: 'Alpha', link: {tone: 'unavailable', label: 'Unavailable'}} satisfies ClientNameView);
  });

  it('ip accessor falls back to a dash', () => {
    expect(accessorOf('ip')(client({ip: null}))).toBe('—');
    expect(accessorOf('ip')(client({ip: '10.0.0.1'}))).toBe('10.0.0.1');
  });

  it('connection accessor builds a wireless line', () => {
    const wireless: WirelessConnectionInfo = {accessPointId: 'ap0', bands: ['2', '5'], txrate: 300, rssi: -50, txss: 2};

    expect(accessorOf('connection')(client({connectionType: 'wireless', connection: wireless})))
      .toEqual({kind: 'wireless', text: 'RSSI: -50; 300 Mbps; 2.4 GHz, 5 GHz'} satisfies ConnectionView);
  });

  it('connection accessor is none for unknown', () => {
    expect(accessorOf('connection')(client())).toEqual({kind: 'none'} satisfies ConnectionView);
  });

  it('connection accessor builds a wired line with speed and port', () => {
    expect(accessorOf('connection')(client({connectionType: 'wired', connection: {speed: 1000, port: '2'}})))
      .toEqual({kind: 'wired', speed: '1000 Mbps', port: 'Port 2'} satisfies ConnectionView);
  });

  it('connection accessor dashes invalid wired speed and port', () => {
    expect(accessorOf('connection')(client({connectionType: 'wired', connection: {speed: null, port: null}})))
      .toEqual({kind: 'wired', speed: '—', port: '—'} satisfies ConnectionView);
    expect(
      accessorOf('connection')(client({connectionType: 'wired', connection: {speed: Number.NaN, port: 'undefined'}})),
    )
      .toEqual({kind: 'wired', speed: '—', port: '—'} satisfies ConnectionView);
  });

  it('connection accessor dashes empty wireless bands', () => {
    const wireless: WirelessConnectionInfo = {accessPointId: 'ap0', bands: [], txrate: 300, rssi: -50, txss: 2};

    expect(accessorOf('connection')(client({connectionType: 'wireless', connection: wireless})))
      .toEqual({kind: 'wireless', text: 'RSSI: -50; 300 Mbps; —'} satisfies ConnectionView);
  });

  it('uptime accessor returns a dash with no title when null', () => {
    expect(accessorOf('uptime')(client({uptime: null})))
      .toEqual({text: '—', title: undefined} satisfies TitledText);
  });

  it('uptime/lastSeen accessors carry compact text and the exact full-duration title when set', () => {
    const uptime = accessorOf('uptime')(client({uptime: 1483})) as TitledText;

    expect(uptime.text).toBe(formatCompactDuration(1483));
    expect(uptime.title).toBe(formatFullDuration(1483));

    const lastSeen = accessorOf('lastSeen')(client({lastSeen: 12})) as TitledText;

    expect(lastSeen.text).toBe(formatElapsed(12));
    expect(lastSeen.title).toBe(formatFullDuration(12));
  });
});
