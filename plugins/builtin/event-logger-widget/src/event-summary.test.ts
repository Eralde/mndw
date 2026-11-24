import {describe, expect, it} from 'vitest';
import type {MndwEvent} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import enMessages from '../i18n/en.json';
import ruMessages from '../i18n/ru.json';
import {summarizeEvent} from './event-summary.js';

const BASE = {id: '01J8ZQ6ZK3W4T5Y6V7W8X9ABCD', ts: 1} as const;

const CASES: ReadonlyArray<{event: MndwEvent; en: string}> = [
  {
    event: {
      ...BASE,
      topic: 'wan.connected',
      source: 'hook',
      payload: {interface: 'ppp0', address: '203.0.113.7', mask: '255.255.255.255', gateway: '203.0.113.1'},
    },
    en: 'WAN connected: ppp0, 203.0.113.7',
  },
  {
    event: {...BASE, topic: 'wan.disconnected', source: 'hook', payload: {interface: 'ppp0'}},
    en: 'WAN disconnected: ppp0',
  },
  {
    event: {
      ...BASE,
      topic: 'net.ip_changed',
      source: 'hook',
      payload: {
        interface: 'WifiMaster0/WifiStation0',
        systemName: 'apcli0',
        address: '192.168.1.10',
        mask: '255.255.255.0',
        link: 'up',
        connected: true,
      },
    },
    en: 'IP address changed: 192.168.1.10/255.255.255.0 on WifiMaster0/WifiStation0',
  },
  {
    event: {
      ...BASE,
      topic: 'net.dhcp_lease',
      source: 'log',
      payload: {mac: 'AA:BB', ip: '192.168.1.50', hostname: 'laptop', action: 'added'},
    },
    en: 'DHCP lease added: laptop (192.168.1.50)',
  },
  {
    event: {...BASE, topic: 'net.dns_changed', source: 'log', payload: {resolvers: ['1.1.1.1', '8.8.8.8']}},
    en: 'DNS resolvers changed: 1.1.1.1, 8.8.8.8',
  },
  {
    event: {
      ...BASE,
      topic: 'wifi.client_join',
      source: 'log',
      payload: {mac: 'AA:BB:CC:DD:EE:FF', band: '5GHz', ssid: 'HomeNet', iface: 'wlan0'},
    },
    en: 'Wi-Fi client joined: AA:BB:CC:DD:EE:FF (HomeNet, 5GHz)',
  },
  {
    event: {
      ...BASE,
      topic: 'wifi.client_leave',
      source: 'log',
      payload: {mac: 'AA:BB:CC:DD:EE:FF', band: '5GHz', ssid: 'HomeNet', iface: 'wlan0'},
    },
    en: 'Wi-Fi client left: AA:BB:CC:DD:EE:FF (HomeNet, 5GHz)',
  },
  {
    event: {...BASE, topic: 'firewall.rebuilt', source: 'hook', payload: {table_type: 'nat', table: 'prerouting'}},
    en: 'Firewall rebuilt: nat prerouting',
  },
  {
    event: {
      ...BASE,
      topic: 'usb.attached',
      source: 'hook',
      payload: {device: 'sda', model: 'USB Drive', vendor: 'Acme', port: '1-1'},
    },
    en: 'USB device attached: Acme USB Drive',
  },
  {
    event: {...BASE, topic: 'usb.detached', source: 'hook', payload: {device: 'sda', port: '1-1'}},
    en: 'USB device detached: sda (port 1-1)',
  },
  {
    event: {
      ...BASE,
      topic: 'fs.mounted',
      source: 'hook',
      payload: {fs_type: 'ext4', label: 'data', directory: '/tmp/mnt/data'},
    },
    en: 'Filesystem mounted: data at /tmp/mnt/data',
  },
  {
    event: {
      ...BASE,
      topic: 'fs.unmounted',
      source: 'hook',
      payload: {label: 'data', directory: '/tmp/mnt/data'},
    },
    en: 'Filesystem unmounted: data at /tmp/mnt/data',
  },
  {
    event: {...BASE, topic: 'clock.synced', source: 'hook', payload: {}},
    en: 'Clock synchronized',
  },
  {
    event: {...BASE, topic: 'schedule.fired', source: 'hook', payload: {name: 'backup', action: 'start', elapsed: 0}},
    en: 'Schedule fired: backup (start)',
  },
  {
    event: {...BASE, topic: 'button.pressed', source: 'hook', payload: {button: 'wifi', gesture: 'short'}},
    en: 'Button pressed: wifi (short)',
  },
  {
    event: {
      ...BASE,
      topic: 'auth.login',
      source: 'log',
      payload: {user: 'admin', ip: '192.168.1.20', success: true},
    },
    en: 'Login succeeded: admin from 192.168.1.20',
  },
  {
    event: {...BASE, topic: 'firmware.available', source: 'log', payload: {version: '4.2.1'}},
    en: 'Firmware update available: 4.2.1',
  },
  {
    event: {...BASE, topic: 'plugin.installed', source: 'internal', payload: {name: 'ping-widget', version: '1.0.0'}},
    en: 'Plugin installed: ping-widget 1.0.0',
  },
  {
    event: {...BASE, topic: 'plugin.removed', source: 'internal', payload: {name: 'ping-widget'}},
    en: 'Plugin removed: ping-widget',
  },
  {
    event: {...BASE, topic: 'plugin.approved', source: 'internal', payload: {name: 'ping-widget', version: '1.0.0'}},
    en: 'Plugin approved: ping-widget 1.0.0',
  },
  {
    event: {...BASE, topic: 'plugin.started', source: 'internal', payload: {name: 'ping-widget'}},
    en: 'Plugin started: ping-widget',
  },
  {
    event: {
      ...BASE,
      topic: 'plugin.stopped',
      source: 'internal',
      payload: {name: 'ping-widget', reason: 'crash'},
    },
    en: 'Plugin stopped: ping-widget (crash)',
  },
  {
    event: {...BASE, topic: 'daemon.started', source: 'internal', payload: {version: '1.2.3', uptime_ms: 0}},
    en: 'Daemon started: 1.2.3',
  },
  {
    event: {...BASE, topic: 'daemon.stopping', source: 'internal', payload: {reason: 'shutdown'}},
    en: 'Daemon stopping: shutdown',
  },
  {
    event: {...BASE, topic: 'daemon.updated', source: 'internal', payload: {version: '1.2.4'}},
    en: 'Daemon updated: 1.2.4',
  },
  {
    event: {
      ...BASE,
      topic: 'storage.low',
      source: 'internal',
      payload: {path: '/opt', available_bytes: 123456789, threshold_bytes: 268435456},
    },
    en: 'Low storage on /opt: 117.7 MB available (threshold 256.0 MB)',
  },
  {
    event: {...BASE, topic: 'telemetry.gathering_changed', source: 'internal', payload: {enabled: true}},
    en: 'Telemetry gathering enabled',
  },
];

const enI18n = createTestI18n(enMessages);

describe('summarizeEvent', () => {
  it('summarizes every schema topic in English', () => {
    for (const testCase of CASES) {
      expect(summarizeEvent(testCase.event, enI18n), testCase.event.topic).toBe(testCase.en);
    }
  });

  it('has a translated summary for every topic in both catalogs', () => {
    for (const i18n of [enI18n, createTestI18n(ruMessages, 'ru')]) {
      for (const {event} of CASES) {
        const summary = summarizeEvent(event, i18n);

        expect(summary, event.topic).not.toBe(event.topic);
        expect(summary, event.topic).not.toMatch(/^summary\./);
        expect(summary, event.topic).not.toMatch(/\{[a-z_]+\}/);
      }
    }
  });

  it('uses the login result and the optional clock offset', () => {
    const failedLogin: MndwEvent = {
      ...BASE,
      topic: 'auth.login',
      source: 'log',
      payload: {user: 'admin', ip: '192.168.1.20', success: false},
    };
    const synced: MndwEvent = {...BASE, topic: 'clock.synced', source: 'hook', payload: {offset_ms: 12}};
    const ruI18n = createTestI18n(ruMessages, 'ru');

    expect(summarizeEvent(failedLogin, enI18n)).toBe('Login failed: admin from 192.168.1.20');
    expect(summarizeEvent(failedLogin, ruI18n)).toBe('Ошибка входа: admin с 192.168.1.20');
    expect(summarizeEvent(synced, enI18n)).toBe('Clock synchronized (offset 12 ms)');
    expect(summarizeEvent(synced, ruI18n)).toBe('Часы синхронизированы (смещение 12 мс)');
  });

  it('formats low-storage sizes with one decimal and localized units', () => {
    const lowStorage: MndwEvent = {
      ...BASE,
      topic: 'storage.low',
      source: 'internal',
      payload: {path: '/opt', available_bytes: 123456789, threshold_bytes: 268435456},
    };
    const tiny: MndwEvent = {
      ...BASE,
      topic: 'storage.low',
      source: 'internal',
      payload: {path: '/opt', available_bytes: 512, threshold_bytes: 1024},
    };
    const ruI18n = createTestI18n(ruMessages, 'ru');

    expect(summarizeEvent(lowStorage, enI18n)).toBe(
      'Low storage on /opt: 117.7 MB available (threshold 256.0 MB)',
    );
    expect(summarizeEvent(lowStorage, ruI18n)).toBe(
      'Мало места на /opt: доступно 117,7 МБ (порог 256,0 МБ)',
    );
    expect(summarizeEvent(tiny, enI18n)).toBe('Low storage on /opt: 512 B available (threshold 1.0 KB)');
    expect(summarizeEvent(tiny, ruI18n)).toBe('Мало места на /opt: доступно 512 Б (порог 1,0 КБ)');
  });

  it('falls back to the raw topic for an unknown event', () => {
    const unknown = {
      ...BASE,
      topic: 'future.topic',
      source: 'hook',
      payload: {},
    } as unknown as MndwEvent;

    expect(summarizeEvent(unknown, enI18n)).toBe('future.topic');
  });
});
