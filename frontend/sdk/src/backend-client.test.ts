import {describe, expect, it, vi} from 'vitest';
import {
  BackendBadGateway,
  type BackendDescriptor,
  BackendDisabled,
  BackendIncompatible,
  BackendMaintenance,
  BackendNotApproved,
  BackendStarting,
  BackendUnavailable,
  BackendUnknownId,
  createBackendClient,
  isBackendMaintenanceClose,
} from './backend-client.js';

const descriptor = (over: Partial<BackendDescriptor> = {}): BackendDescriptor => ({
  routes: {
    stats: {transport: 'http', method: 'GET', path: 'stats'},
    submit: {transport: 'http', method: 'POST', path: 'submit'},
    term: {transport: 'websocket', path: 'term', protocols: ['tty']},
  },
  approval: 'approved',
  enabled: true,
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

describe('backend maintenance close', () => {
  it('classifies intentional update closure without reconnecting', () => {
    expect(isBackendMaintenanceClose({code: 1012, reason: 'mndw updating'})).toBe(true);
    expect(isBackendMaintenanceClose({code: 1012, reason: 'other'})).toBe(false);
    expect(isBackendMaintenanceClose({code: 1000, reason: 'mndw updating'})).toBe(false);
  });
});

describe('createBackendClient.fetch', () => {
  it('overwrites CSRF header for unsafe routes and preserves no header for GET', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', {status: 200}));

    await client({
      routes: {submit: {transport: 'http', method: 'POST', path: 'submit'},
        stats: {transport: 'http', method: 'GET', path: 'stats'}},
    }, fetchImpl).fetch('submit', {headers: {'X-Mndw-Csrf': '0'}});
    await client({
      routes: {submit: {transport: 'http', method: 'POST', path: 'submit'},
        stats: {transport: 'http', method: 'GET', path: 'stats'}},
    }, fetchImpl).fetch('stats', {headers: {'X-Mndw-Csrf': '0'}});
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('X-Mndw-Csrf')).toBe('1');
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('X-Mndw-Csrf')).toBe('0');
  });
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

  it.each(
    [
      ['BACKEND_UNAVAILABLE', BackendUnavailable],
      ['BACKEND_INCOMPATIBLE', BackendIncompatible],
      ['BAD_GATEWAY', BackendBadGateway],
    ] as const,
  )('maps daemon %s envelopes', async (code, ErrorType) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({error: {code, message: 'x'}}), {status: 503}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      daemonCode: code,
    });
    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(ErrorType);
  });

  it.each(
    [
      ['BACKEND_STARTING', BackendStarting],
      ['BACKEND_MAINTENANCE', BackendMaintenance],
    ] as const,
  )('maps %s with a valid retry delay', async (code, ErrorType) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({error: {code, message: 'x'}}), {
        status: 503,
        headers: {'Retry-After': '4'},
      }),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      daemonCode: code,
      retryAfterSeconds: 4,
    });
    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(ErrorType);
  });

  it.each([undefined, '', '-1', '1.5', 'soon'])('maps invalid retry delay %s to null', async (retryAfter) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({error: {code: 'BACKEND_STARTING', message: 'x'}}), {
        status: 503,
        headers: retryAfter === undefined ? undefined : {'Retry-After': retryAfter},
      }),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      daemonCode: 'BACKEND_STARTING',
      retryAfterSeconds: null,
    });
  });

  it('does not add daemonCode to existing backend errors', async () => {
    await expect(client({enabled: false}).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      code: 'DISABLED',
    });
    await expect(client({enabled: false}).fetch('stats')).rejects.not.toHaveProperty('daemonCode');
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

describe('command-free route descriptors', () => {
  it('resolves HTTP and WebSocket routes from one map', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const routeDescriptor = {
      routes: {
        stats: {transport: 'http', method: 'GET', path: 'stats'},
        term: {transport: 'websocket', path: 'term', protocols: ['tty']},
      },
      approval: 'approved',
      enabled: true,
    } as unknown as BackendDescriptor;
    const backend = createBackendClient('demo', routeDescriptor, {
      fetch: fetchImpl,
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      origin: 'https://host',
    });

    await backend.fetch('stats');

    const socket = backend.socket('term') as unknown as FakeWebSocket;

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://host/api/plugins/demo/stats');
    expect(socket.url).toBe('wss://host/ws/plugins/demo/term');
    expect(socket.protocols).toEqual(['tty']);
  });
});
