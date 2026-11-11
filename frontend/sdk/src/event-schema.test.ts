import {readFileSync, readdirSync} from 'node:fs';
import {z} from 'zod';
import {describe, expect, it} from 'vitest';

import {
  MaxEventPayloadBytes,
  type MndwEvent,
  createEventSchemaDocument,
  eventPermissionSchema,
  eventSchema,
} from './event-schema.js';

const checkReadonlyEventType = (topicEvent: MndwEvent, payloadEvent: MndwEvent): void => {
  // @ts-expect-error SDK events must not allow topic mutation.
  topicEvent.topic = 'plugin.started';

  if (payloadEvent.topic === 'net.dns_changed') {
    // @ts-expect-error SDK events must not allow nested payload mutation.
    payloadEvent.payload.resolvers[0] = '9.9.9.9';
  }
};

void checkReadonlyEventType;

const validEvent = (topic: string, source: MndwEvent['source'], payload: Record<string, unknown>): MndwEvent => {
  return {
    id: '01J5KZ00000000000000000000',
    ts: 1725552000123,
    topic,
    source,
    payload,
  } as MndwEvent;
};

describe('event contract', () => {
  it('accepts every v1 topic with its documented payload', () => {
    const events: MndwEvent[] = [
      validEvent('wan.connected', 'hook', {interface: 'ppp0', address: '192.0.2.1', mask: '255.255.255.0',
        gateway: '192.0.2.254'}),
      validEvent('wan.disconnected', 'hook', {interface: 'ppp0'}),
      validEvent('net.ip_changed', 'hook', {address: '192.0.2.1', mask: '255.255.255.0', link: 'wan', connected: true}),
      validEvent('net.dhcp_lease', 'log', {mac: '00:11:22:33:44:55', ip: '192.0.2.10', hostname: 'router',
        action: 'bound'}),
      validEvent('net.dns_changed', 'log', {resolvers: ['192.0.2.53']}),
      validEvent('wifi.client_join', 'log', {mac: '00:11:22:33:44:55', band: '5ghz', ssid: 'mndw',
        iface: 'WifiMaster0'}),
      validEvent('wifi.client_leave', 'log', {mac: '00:11:22:33:44:55', band: '5ghz', ssid: 'mndw',
        iface: 'WifiMaster0'}),
      validEvent('firewall.rebuilt', 'hook', {table_type: 'filter', table: 'inet'}),
      validEvent('usb.attached', 'hook', {device: '/dev/sda1', model: 'Disk', vendor: 'ACME', port: 'usb1'}),
      validEvent('usb.detached', 'hook', {device: '/dev/sda1', port: 'usb1'}),
      validEvent('fs.mounted', 'hook', {fs_type: 'ext4', label: 'DATA', directory: '/opt'}),
      validEvent('fs.unmounted', 'hook', {label: 'DATA', directory: '/opt'}),
      validEvent('clock.synced', 'hook', {offset_ms: 12}),
      validEvent('schedule.fired', 'hook', {name: 'nightly', action: 'start', elapsed: 42}),
      validEvent('button.pressed', 'hook', {button: 'reset', gesture: 'short'}),
      validEvent('auth.login', 'log', {user: 'admin', ip: '192.0.2.2', success: true}),
      validEvent('firmware.available', 'log', {version: '4.2.0'}),
      validEvent('plugin.installed', 'internal', {name: 'demo', version: '1.0.0'}),
      validEvent('plugin.removed', 'internal', {name: 'demo'}),
      validEvent('plugin.approved', 'internal', {name: 'demo', version: '1.0.0'}),
      validEvent('plugin.started', 'internal', {name: 'demo'}),
      validEvent('plugin.stopped', 'internal', {name: 'demo', reason: 'disabled'}),
      validEvent('daemon.started', 'internal', {version: '2.0.0', uptime_ms: 0}),
      validEvent('daemon.stopping', 'internal', {reason: 'signal'}),
      validEvent('daemon.updated', 'internal', {version: '2.0.0'}),
      validEvent('storage.low', 'internal', {path: '/opt', available_bytes: 1, threshold_bytes: 5242880}),
      validEvent('telemetry.gathering_changed', 'internal', {enabled: false}),
    ];

    expect(events).toHaveLength(27);

    for (const event of events) {
      expect(eventSchema.parse(event)).toEqual(event);
    }
  });

  it('allows clock sync without an offset', () => {
    expect(eventSchema.parse(validEvent('clock.synced', 'hook', {}))).toEqual(
      validEvent('clock.synced', 'hook', {}),
    );
  });

  it('accepts telemetry gathering changes and rejects invalid sources or payloads', () => {
    const event = validEvent('telemetry.gathering_changed', 'internal', {enabled: false});

    expect(eventSchema.parse(event)).toEqual(event);
    expect(() => eventSchema.parse({...event, payload: {enabled: false, extra: true}})).toThrow();
    expect(() => eventSchema.parse({...event, source: 'hook'})).toThrow();
  });

  it('rejects malformed envelopes and payloads', () => {
    expect(() => eventSchema.parse({...validEvent('wan.connected', 'hook', {}), id: 'bad'})).toThrow();
    expect(() =>
      eventSchema.parse(validEvent('wan.connected', 'internal', {
        interface: 'ppp0',
        address: '192.0.2.1',
        mask: '255.255.255.0',
        gateway: '192.0.2.254',
      }))
    ).toThrow();
    expect(() =>
      eventSchema.parse(validEvent('wan.connected', 'hook', {
        interface: 'ppp0',
        address: '192.0.2.1',
        mask: '255.255.255.0',
        gateway: '192.0.2.254',
        extra: true,
      }))
    ).toThrow();
  });

  it('validates event permissions', () => {
    expect(eventPermissionSchema.parse('events:*')).toBe('events:*');
    expect(eventPermissionSchema.parse('events:wan,wifi,net')).toBe('events:wan,wifi,net');
    expect(() => eventPermissionSchema.parse('events:WAN')).toThrow();
    expect(() => eventPermissionSchema.parse('events:')).toThrow();
    expect(() => eventPermissionSchema.parse('events:wan,')).toThrow();
  });

  it('generates a JSON Schema document from the runtime schema', () => {
    const document = createEventSchemaDocument();

    expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(document.title).toBe('mndw unified event');
    expect(JSON.stringify(document)).toContain('daemon.updated');
  });

  it('throws when the event schema contains an unrepresentable Zod type', () => {
    expect(() => createEventSchemaDocument(z.date())).toThrow();
  });

  it('accepts shared valid fixtures and rejects shared invalid fixtures', () => {
    const readFixtures = (kind: 'valid' | 'invalid'): unknown[] => {
      return readdirSync(new URL(`../fixtures/events/${kind}/`, import.meta.url))
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => {
          return JSON.parse(
            readFileSync(new URL(`../fixtures/events/${kind}/${file}`, import.meta.url), 'utf8'),
          ) as unknown;
        });
    };

    for (const fixture of readFixtures('valid')) {
      expect(eventSchema.safeParse(fixture).success).toBe(true);
    }

    for (const fixture of readFixtures('invalid')) {
      expect(eventSchema.safeParse(fixture).success).toBe(false);
    }

    const oversized = JSON.parse(readFileSync(
      new URL('../fixtures/events/invalid/oversized-payload.json', import.meta.url),
      'utf8',
    )) as {payload: unknown};

    expect(new TextEncoder().encode(JSON.stringify(oversized.payload)).length).toBeGreaterThan(MaxEventPayloadBytes);
  });
});
