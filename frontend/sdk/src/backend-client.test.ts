import {describe, expect, it, vi} from 'vitest';
import {
  type BackendDescriptor,
  BackendDisabled,
  BackendNotApproved,
  BackendUnknownId,
  createBackendClient,
} from './backend-client.js';

const descriptor = (over: Partial<BackendDescriptor> = {}): BackendDescriptor => ({
  endpoints: {stats: {method: 'GET', path: 'stats'}, submit: {method: 'POST', path: 'submit'}},
  websockets: {term: {path: 'term', protocols: ['tty']}},
  approval: 'approved',
  enabled: true,
  public: false,
  ...over,
});

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];

  constructor(public readonly url: string, public readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }
}

const client = (over?: Partial<BackendDescriptor>, fetchImpl?: typeof globalThis.fetch) =>
  createBackendClient('demo', descriptor(over), {
    fetch: fetchImpl ?? vi.fn(),
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    origin: 'https://host',
  });

describe('createBackendClient.fetch', () => {
  it('resolves id to a namespaced URL with the declared method', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));

    await client(undefined, fetchImpl).fetch('stats', {query: {n: 5}});

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('https://host/api/plugins/demo/stats?n=5');
    expect(init?.method).toBe('GET');
  });

  it('JSON-encodes a plain object body and sets content-type', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));

    await client(undefined, fetchImpl).fetch('submit', {body: {a: 1}});

    const [, init] = fetchImpl.mock.calls[0];

    expect(init?.body).toBe('{"a":1}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('throws BackendUnknownId synchronously for an unknown id', () => {
    expect(() => client().fetch('nope')).toThrow(BackendUnknownId);
  });

  it('rejects with BackendDisabled when the plugin is disabled', async () => {
    await expect(client({enabled: false}).fetch('stats')).rejects.toBeInstanceOf(BackendDisabled);
  });

  it('rejects with BackendNotApproved when approval is pending', async () => {
    await expect(client({approval: 'pending'}).fetch('stats')).rejects.toBeInstanceOf(BackendNotApproved);
  });

  it('maps a daemon NOT_APPROVED envelope onto BackendNotApproved', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({error: {code: 'NOT_APPROVED', message: 'x'}}), {status: 403}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(BackendNotApproved);
  });

  it('maps a daemon ROUTE_NOT_FOUND envelope onto BackendUnknownId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({error: {code: 'ROUTE_NOT_FOUND'}}), {status: 404}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(BackendUnknownId);
  });

  it('passes non-envelope error responses through to the caller', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', {status: 500}));

    const res = await client(undefined, fetchImpl).fetch('stats');

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
  });
});

describe('createBackendClient.socket', () => {
  it('opens a ws:// URL derived from the origin, with declared protocols', () => {
    FakeWebSocket.instances = [];

    const ws = client().socket('term') as unknown as FakeWebSocket;

    expect(ws.url).toBe('wss://host/ws/plugins/demo/term');
    expect(ws.protocols).toEqual(['tty']);
  });

  it('lets caller-supplied protocols override the declared ones', () => {
    const ws = client().socket('term', {protocols: ['custom']}) as unknown as FakeWebSocket;

    expect(ws.protocols).toEqual(['custom']);
  });

  it('throws BackendUnknownId synchronously for an unknown id', () => {
    expect(() => client().socket('nope')).toThrow(BackendUnknownId);
  });

  it('throws BackendDisabled when the plugin is disabled', () => {
    expect(() => client({enabled: false}).socket('term')).toThrow(BackendDisabled);
  });
});
