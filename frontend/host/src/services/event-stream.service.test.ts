import type {MndwEvent} from '@mndw/sdk';
import {eventSchema} from '@mndw/sdk-internal';
import {map} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {createPluginLifetime} from '../runtime/plugin-lifetime.js';
import {EventStreamManager} from './event-stream.service.js';

const event = (id: string, topic: string) => ({
  id,
  ts: 1725552000123,
  topic,
  source: topic === 'net.dns_changed' || topic === 'wifi.client_join' ? 'log' : 'internal',
  payload: topic === 'plugin.started'
    ? {name: 'demo'}
    : topic === 'wifi.client_join'
    ? {mac: '00:11:22:33:44:55', band: '5g', ssid: 'ssid', iface: 'wlan0'}
    : {resolvers: ['1.1.1.1']},
});

class FakeWebSocket {
  public static readonly OPEN = 1;
  public readonly sent: string[] = [];
  public readyState = 0;
  private readonly listeners = new Map<string, Array<(value: any) => void>>();

  public addEventListener(type: string, listener: (value: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];

    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public send(message: string): void {
    this.sent.push(message);
  }

  public close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  public open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  public receive(message: unknown): void {
    this.emit('message', {data: JSON.stringify(message)});
  }

  private emit(type: string, value: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(value);
    }
  }
}

describe('EventStreamManager', () => {
  it('select$ delivers matching events and unregisters on unsubscribe', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const handler = vi.fn<(event: MndwEvent) => void>();
    const facade = manager.createFacade('instance-1', 'demo', ['events:net'], createPluginLifetime());

    expect(facade).toBeDefined();

    const subscription = facade?.select$('net').subscribe(handler);

    expect(eventSchema.safeParse(event('01J5KZ00000000000000000000', 'net.dns_changed')).success).toBe(true);
    sockets[0]?.open();

    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({type: 'subscribe', topics: ['net']});
    expect(JSON.parse(sockets[0]?.sent[1] ?? '{}')).toEqual({type: 'replay', after: '', limit: 100});

    sockets[0]?.receive({type: 'replay', events: [], hasMore: false});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000000', 'net.dns_changed')});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000001', 'wifi.client_join')});

    expect(handler).toHaveBeenCalledTimes(1);

    const firstCall = handler.mock.calls[0]?.[0] as {topic?: string} | undefined;

    expect(firstCall?.topic).toBe('net.dns_changed');

    subscription?.unsubscribe();
    expect(sockets[0]?.readyState).toBe(3);
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000002', 'net.dns_changed')});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('select$ applies the same permission narrowing as before', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const handler = vi.fn<(event: MndwEvent) => void>();
    const facade = manager.createFacade('instance-1', 'demo', ['events:net'], createPluginLifetime());

    facade?.select$('net.dns_changed').subscribe(handler);
    sockets[0]?.open();

    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({type: 'subscribe', topics: ['net.dns_changed']});
    sockets[0]?.receive({type: 'replay', events: [], hasMore: false});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000000', 'net.dns_changed')});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000001', 'wifi.client_join')});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.topic).toBe('net.dns_changed');
  });

  it.each([
    {
      name: 'wildcard grant narrows to each requested topic',
      permissions: ['events:*'],
      request: 'net,plugin',
      topics: ['net', 'plugin'],
    },
    {
      name: 'wildcard request narrows to each granted topic',
      permissions: ['events:wan'],
      request: '*',
      topics: ['wan'],
    },
    {
      name: 'both wildcards remain wildcard',
      permissions: ['events:*'],
      request: '*',
      topics: ['*'],
    },
    {
      name: 'parent grant narrows to child request',
      permissions: ['events:net'],
      request: 'net.dns_changed',
      topics: ['net.dns_changed'],
    },
    {
      name: 'child grant narrows parent request',
      permissions: ['events:plugin.started'],
      request: 'plugin',
      topics: ['plugin.started'],
    },
    {
      name: 'disjoint grants and requests produce no wire subscription',
      permissions: ['events:net'],
      request: 'plugin',
      topics: [],
    },
    {
      name: 'comma lists and multiple grants and requests narrow together',
      permissions: ['events:wan,plugin', 'events:net'],
      request: 'plugin,net.dns_changed,wan.connected,usb',
      topics: ['net.dns_changed', 'plugin', 'wan.connected'],
    },
    {
      name: 'multiple grants intersect a wildcard request',
      permissions: ['events:wan,plugin', 'events:net'],
      request: '*,usb',
      topics: ['net', 'plugin', 'wan'],
    },
  ])('narrows $name', ({permissions, request, topics}) => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const facade = manager.createFacade('instance-1', 'demo', permissions, createPluginLifetime());

    facade?.select$(request).subscribe();

    if (topics.length === 0) {
      expect(sockets).toHaveLength(0);

      return;
    }

    sockets[0]?.open();

    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({type: 'subscribe', topics});
  });

  it('does not deliver topics outside the effective filter for a wildcard request', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const handler = vi.fn<(event: MndwEvent) => void>();
    const facade = manager.createFacade('instance-1', 'demo', ['events:wan'], createPluginLifetime());

    facade?.select$('*').subscribe(handler);
    sockets[0]?.open();
    sockets[0]?.receive({type: 'replay', events: [], hasMore: false});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000000', 'plugin.started')});

    expect(handler).not.toHaveBeenCalled();
  });

  it('drains replay pages, deduplicates overlap, and calls resync after buffered live events', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const handler = vi.fn<(event: MndwEvent) => void>();
    const resync = vi.fn();
    const facade = manager.createFacade('instance-1', 'demo', ['events:*'], createPluginLifetime());

    facade?.select$('*').subscribe(handler);
    facade?.resync$.subscribe(resync);
    sockets[0]?.open();
    sockets[0]?.receive({type: 'replay', events: [event('01J5KZ00000000000000000000', 'plugin.started')],
      hasMore: true});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000002', 'plugin.started')});
    sockets[0]?.receive({type: 'replay', events: [event('01J5KZ00000000000000000001', 'plugin.started')],
      hasMore: false});

    expect(handler).toHaveBeenCalledTimes(3);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sockets[0]?.sent[2] ?? '{}')).toEqual({
      type: 'replay',
      after: '01J5KZ00000000000000000000',
      limit: 100,
    });
  });

  it('subscribes immediately during replay and deduplicates replay/live overlap for new topics', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const netHandler = vi.fn<(event: MndwEvent) => void>();
    const pluginHandler = vi.fn<(event: MndwEvent) => void>();
    const netFacade = manager.createFacade('instance-net', 'net-plugin', ['events:net'], createPluginLifetime());
    const pluginFacade = manager.createFacade(
      'instance-plugin',
      'plugin-listener',
      ['events:plugin'],
      createPluginLifetime(),
    );

    netFacade?.select$('net').subscribe(netHandler);
    sockets[0]?.open();

    pluginFacade?.select$('plugin').subscribe(pluginHandler);

    expect(JSON.parse(sockets[0]?.sent[2] ?? '{}')).toEqual({type: 'subscribe', topics: ['net', 'plugin']});

    const netEvent = event('01J5KZ00000000000000000000', 'net.dns_changed');
    const pluginEvent = event('01J5KZ00000000000000000001', 'plugin.started');

    sockets[0]?.receive({type: 'replay', events: [netEvent], hasMore: true});
    sockets[0]?.receive({type: 'event', event: pluginEvent});
    sockets[0]?.receive({type: 'replay', events: [pluginEvent], hasMore: false});

    expect(netHandler).toHaveBeenCalledTimes(1);
    expect(pluginHandler).toHaveBeenCalledTimes(1);
    expect(pluginHandler.mock.calls[0]?.[0]?.id).toBe(pluginEvent.id);

    const nextPluginEvent = event('01J5KZ00000000000000000002', 'plugin.started');

    sockets[0]?.receive({type: 'event', event: nextPluginEvent});

    expect(pluginHandler).toHaveBeenCalledTimes(2);
    expect(pluginHandler.mock.calls[1]?.[0]?.id).toBe(nextPluginEvent.id);
  });

  it('does not resend when subscriptions leave the sorted wire filter set unchanged', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const facade = manager.createFacade('instance-1', 'demo', ['events:net,plugin'], createPluginLifetime());
    const first = facade?.select$('net,plugin').subscribe();

    sockets[0]?.open();

    const second = facade?.select$('plugin,net').subscribe();

    first?.unsubscribe();

    expect(sockets[0]?.sent.map((message) => JSON.parse(message))).toEqual([
      {type: 'subscribe', topics: ['net', 'plugin']},
      {type: 'replay', after: '', limit: 100},
    ]);

    second?.unsubscribe();
  });

  it('reopens after unsubscribe-to-empty during replay and resumes from last delivered event', () => {
    const sockets: FakeWebSocket[] = [];
    const reconnects: Array<() => void> = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
      setTimeout: ((handler: () => void) => {
        reconnects.push(handler);

        return reconnects.length as unknown as ReturnType<typeof globalThis.setTimeout>;
      }) as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    });
    const handler = vi.fn<(event: MndwEvent) => void>();
    const facade = manager.createFacade('instance-1', 'demo', ['events:net'], createPluginLifetime());
    const subscription = facade?.select$('net').subscribe(handler);

    sockets[0]?.open();

    const deliveredEvent = event('01J5KZ00000000000000000000', 'net.dns_changed');
    const bufferedEvent = event('01J5KZ00000000000000000001', 'net.dns_changed');

    sockets[0]?.receive({type: 'replay', events: [deliveredEvent], hasMore: true});
    sockets[0]?.receive({type: 'event', event: bufferedEvent});
    subscription?.unsubscribe();

    expect(sockets[0]?.readyState).toBe(3);
    expect(reconnects).toHaveLength(0);
    expect(handler).toHaveBeenCalledOnce();

    facade?.select$('net').subscribe(handler);

    expect(sockets).toHaveLength(2);

    sockets[1]?.open();

    expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toEqual({type: 'subscribe', topics: ['net']});
    expect(JSON.parse(sockets[1]?.sent[1] ?? '{}')).toEqual({
      type: 'replay',
      after: deliveredEvent.id,
      limit: 100,
    });

    sockets[1]?.receive({type: 'replay', events: [bufferedEvent], hasMore: false});

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]?.id).toBe(bufferedEvent.id);
  });

  it('keeps current filters after cursor expiry and sends them on reconnect', () => {
    const sockets: FakeWebSocket[] = [];
    const reconnects: Array<() => void> = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
      setTimeout: ((handler: () => void) => {
        reconnects.push(handler);

        return reconnects.length as unknown as ReturnType<typeof globalThis.setTimeout>;
      }) as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    });
    const handler = vi.fn<(event: MndwEvent) => void>();
    const netFacade = manager.createFacade('instance-net', 'net-plugin', ['events:net'], createPluginLifetime());
    const pluginFacade = manager.createFacade(
      'instance-plugin',
      'plugin-listener',
      ['events:plugin'],
      createPluginLifetime(),
    );

    netFacade?.select$('net').subscribe();
    sockets[0]?.open();
    pluginFacade?.select$('plugin').subscribe(handler);
    sockets[0]?.receive({type: 'error', code: 'CURSOR_EXPIRED', message: 'expired'});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000000', 'plugin.started')});

    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.parse(sockets[0]?.sent[2] ?? '{}')).toEqual({type: 'subscribe', topics: ['net', 'plugin']});

    sockets[0]?.close();
    reconnects[0]?.();
    sockets[1]?.open();

    expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toEqual({type: 'subscribe', topics: ['net', 'plugin']});
  });

  it('freezes each event before sharing it with subscribers and filtering later events', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const mutationErrors: unknown[] = [];
    const allFacade = manager.createFacade('instance-all', 'all-events', ['events:*'], createPluginLifetime());
    const netFacade = manager.createFacade('instance-net', 'net-events', ['events:net'], createPluginLifetime());
    const allEvents: MndwEvent[] = [];
    const netEvents: MndwEvent[] = [];

    allFacade?.select$('*').subscribe((received) => {
      allEvents.push(received);

      const mutable = received as unknown as {topic: string; payload: {resolvers: string[]}};

      try {
        mutable.payload.resolvers = ['9.9.9.9'];
      } catch (error) {
        mutationErrors.push(error);
      }

      try {
        mutable.payload.resolvers[0] = '9.9.9.9';
      } catch (error) {
        mutationErrors.push(error);
      }

      try {
        mutable.topic = 'plugin.started';
      } catch (error) {
        mutationErrors.push(error);
      }
    });
    netFacade?.select$('net').subscribe((received) => netEvents.push(received));
    sockets[0]?.open();
    sockets[0]?.receive({type: 'replay', events: [], hasMore: false});

    const firstEvent = event('01J5KZ00000000000000000000', 'net.dns_changed');
    const secondEvent = event('01J5KZ00000000000000000001', 'net.dns_changed');

    sockets[0]?.receive({type: 'event', event: firstEvent});
    sockets[0]?.receive({type: 'event', event: secondEvent});

    expect(mutationErrors).toHaveLength(6);
    expect(mutationErrors.every((error) => error instanceof TypeError)).toBe(true);
    expect(netEvents).toHaveLength(2);
    expect(netEvents[0]).toBe(allEvents[0]);
    expect(netEvents[1]).toBe(allEvents[1]);
    expect(netEvents.map(({topic}) => topic)).toEqual(['net.dns_changed', 'net.dns_changed']);
    expect(netEvents.map(({payload}) => payload)).toEqual([
      {resolvers: ['1.1.1.1']},
      {resolvers: ['1.1.1.1']},
    ]);
  });

  it('completes select$ and resync$ when the lifetime ends', () => {
    const sockets: FakeWebSocket[] = [];
    const manager = new EventStreamManager({
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const lifetime = createPluginLifetime();
    const facade = manager.createFacade('instance-1', 'demo', ['events:*'], lifetime);
    const eventComplete = vi.fn();
    const resyncComplete = vi.fn();

    facade?.select$('*').subscribe({complete: eventComplete});
    facade?.resync$.subscribe({complete: resyncComplete});
    lifetime.end();

    expect(eventComplete).toHaveBeenCalledOnce();
    expect(resyncComplete).toHaveBeenCalledOnce();
    expect(sockets[0]?.readyState).toBe(3);
  });

  it('preserves live registrations through cursor expiry and isolates subscriber errors', () => {
    const sockets: FakeWebSocket[] = [];
    const diagnostic = vi.fn();
    const manager = new EventStreamManager({
      diagnostic,
      WebSocket: class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    const subscriberError = vi.fn();
    const healthy = vi.fn<(event: MndwEvent) => void>();
    const resync = vi.fn();
    const facade = manager.createFacade('instance-1', 'demo', ['events:plugin'], createPluginLifetime());

    facade?.select$('plugin').pipe(map(() => {
      throw new Error('subscriber pipeline failed');
    }))
      .subscribe({error: subscriberError});
    facade?.select$('plugin').subscribe(healthy);
    facade?.resync$.subscribe(resync);
    sockets[0]?.open();
    sockets[0]?.receive({type: 'error', code: 'CURSOR_EXPIRED', message: 'expired'});
    sockets[0]?.receive({type: 'event', event: event('01J5KZ00000000000000000000', 'plugin.started')});

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(subscriberError).toHaveBeenCalledOnce();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalled();
  });
});
