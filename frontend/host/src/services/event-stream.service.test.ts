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
