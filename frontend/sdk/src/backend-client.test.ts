import {describe, expect, it, vi} from 'vitest';
import * as sdk from './index.js';
import {
  BackendBadGateway,
  BackendBlocked,
  type BackendDescriptor,
  BackendDisabled,
  BackendError,
  type BackendErrorCode,
  BackendIncompatible,
  BackendMaintenance,
  BackendNotApproved,
  BackendSocketCloseCode,
  BackendStarting,
  BackendStatusQueryError,
  BackendTransportMismatch,
  BackendUnavailable,
  BackendUnknownId,
  createBackendClient,
  isBackendMaintenanceClose,
} from './backend-client.js';

describe('backend errors', () => {
  const errors: ReadonlyArray<[string, Error]> = [
    ['UNKNOWN_ID', new BackendUnknownId('stats')],
    ['NOT_APPROVED', new BackendNotApproved('stats')],
    ['DISABLED', new BackendDisabled('stats')],
    ['TRANSPORT_MISMATCH', new BackendTransportMismatch('stats', 'http')],
    ['BACKEND_STARTING', new BackendStarting('stats', null)],
    ['BACKEND_UNAVAILABLE', new BackendUnavailable('stats')],
    ['BACKEND_INCOMPATIBLE', new BackendIncompatible('stats')],
    ['BACKEND_MAINTENANCE', new BackendMaintenance('stats', null)],
    ['BACKEND_BLOCKED', new BackendBlocked('stats', [], null)],
    ['BAD_GATEWAY', new BackendBadGateway('stats')],
    ['STATUS_QUERY_FAILED', new BackendStatusQueryError(null, 'status failed')],
  ];

  it.each(errors)('%s extends BackendError and exposes matching code', (code, error) => {
    expect(error).toBeInstanceOf(BackendError);
    expect(Reflect.get(error, 'code')).toBe(code);
    expect('daemonCode' in error).toBe(false);
  });

  it('exports BackendError from the package entry and leaves status query id unset', () => {
    expect(sdk).toHaveProperty('BackendError', BackendError);
    expect(Reflect.get(new BackendStatusQueryError(null, 'status failed'), 'id')).toBeUndefined();
  });
});

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

const DAEMON_ERROR_HEADER = 'X-Mndw-Error';
const BAD_REQUEST_COLLISION = {error: {code: 'BAD_REQUEST'}};
const BAD_REQUEST_COLLISION_BODY = JSON.stringify(BAD_REQUEST_COLLISION);

const markedDaemonError = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);

  headers.set(DAEMON_ERROR_HEADER, '1');

  return new Response(JSON.stringify(body), {...init, headers});
};

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

  it('rejects with BackendUnknownId for an unknown id', async () => {
    let pending: Promise<Response> | undefined;

    expect(() => pending = client().fetch('nope')).not.toThrow();
    await expect(pending).rejects.toBeInstanceOf(BackendUnknownId);
  });

  it('rejects with BackendTransportMismatch for a websocket id used by fetch', async () => {
    let pending: Promise<Response> | undefined;

    expect(() => pending = client().fetch('term')).not.toThrow();
    await expect(pending).rejects.toBeInstanceOf(BackendTransportMismatch);
  });

  it('rejects all backend operations when the manifest has no backend declaration', async () => {
    const noBackend = createBackendClient('demo', undefined, {
      fetch: vi.fn(),
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      origin: 'https://host',
    });
    let fetchPromise: Promise<Response> | undefined;
    let callPromise: Promise<unknown> | undefined;
    let statusPromise: Promise<unknown> | undefined;

    expect(() => fetchPromise = noBackend.fetch('anything')).not.toThrow();
    expect(() => callPromise = noBackend.call('anything')).not.toThrow();
    expect(() => statusPromise = noBackend.status()).not.toThrow();

    const expected = {
      name: 'BackendError',
      code: 'BACKEND_NOT_DECLARED',
      message: expect.stringContaining('manifest backend field'),
    };

    await expect(fetchPromise).rejects.toMatchObject(expected);
    await expect(callPromise).rejects.toMatchObject(expected);
    await expect(statusPromise).rejects.toMatchObject(expected);

    let socketError: unknown;

    try {
      noBackend.socket('anything');
    } catch (error) {
      socketError = error;
    }

    expect(socketError).toMatchObject(expected);
  });

  it('rejects with BackendTransportMismatch for an HTTP id used by call', async () => {
    let pending: Promise<unknown> | undefined;

    expect(() => pending = client().call('term')).not.toThrow();
    await expect(pending).rejects.toBeInstanceOf(BackendTransportMismatch);
  });

  it('rejects with BackendDisabled when the plugin is disabled', async () => {
    await expect(client({enabled: false}).fetch('stats')).rejects.toBeInstanceOf(BackendDisabled);
  });

  it('rejects with BackendNotApproved when approval is pending', async () => {
    await expect(client({approval: 'pending'}).fetch('stats')).rejects.toBeInstanceOf(BackendNotApproved);
  });

  it('allows an approved and enabled binding through the gate', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok', {status: 200}));

    await expect(client(undefined, fetchImpl).fetch('stats')).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a daemon NOT_APPROVED envelope onto BackendNotApproved', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code: 'NOT_APPROVED', message: 'x'}}, {status: 403}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(BackendNotApproved);
  });

  it('maps a daemon ROUTE_NOT_FOUND envelope onto BackendUnknownId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code: 'ROUTE_NOT_FOUND'}}, {status: 404}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(BackendUnknownId);
    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({code: 'ROUTE_NOT_FOUND'});
  });

  it.each(
    [
      ['BAD_REQUEST', false],
      ['INTERNAL', false],
      ['SERVER_BUSY', true],
      ['REQUEST_TIMEOUT', true],
      ['SCRIPT_FAILED', false],
      ['SCRIPT_TIMEOUT', true],
      ['BACKEND_BUSY', true],
      ['BACKEND_BODY_TOO_LARGE', false],
      ['BACKEND_OUTPUT_TOO_LARGE', false],
      ['CSRF_REQUIRED', false],
      ['UNAUTHORIZED', false],
    ] as const,
  )('maps daemon exec/proxy code %s with status, details, and retryable=%s', async (code, retryable) => {
    const detail = code === 'SCRIPT_FAILED' ? 'command stderr' : {source: 'daemon'};
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code, message: 'Platform request failed', detail}}, {status: 500}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      name: 'BackendError',
      code,
      message: 'Platform request failed',
      status: 500,
      id: 'stats',
      retryable,
      details: detail,
    });
  });

  it.each(
    [
      ['ROUTE_NOT_FOUND', false],
      ['NOT_APPROVED', false],
      ['DISABLED', false],
      ['BACKEND_STARTING', true],
      ['BACKEND_UNAVAILABLE', true],
      ['BACKEND_INCOMPATIBLE', false],
      ['BACKEND_MAINTENANCE', true],
      ['BACKEND_BLOCKED', false],
      ['BAD_GATEWAY', true],
    ] as const,
  )('maps daemon lifecycle code %s with retryable=%s', async (code, retryable) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code, message: 'Lifecycle request failed', detail: 'details'}}, {
        status: 503,
      }),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      code,
      status: 503,
      id: 'stats',
      retryable,
      details: 'details',
    });
  });

  it.each(
    [
      ['BACKEND_UNAVAILABLE', BackendUnavailable],
      ['BACKEND_INCOMPATIBLE', BackendIncompatible],
      ['BAD_GATEWAY', BackendBadGateway],
    ] as const,
  )('maps daemon %s envelopes', async (code, ErrorType) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code, message: 'x'}}, {status: 503}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      code,
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
      markedDaemonError({error: {code, message: 'x'}}, {
        status: 503,
        headers: {'Retry-After': '4'},
      }),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      code,
      retryAfterSeconds: 4,
    });
    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(ErrorType);
  });

  it.each([undefined, '', '-1', '1.5', 'soon'])('maps invalid retry delay %s to null', async (retryAfter) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code: 'BACKEND_STARTING', message: 'x'}}, {
        status: 503,
        headers: retryAfter === undefined ? undefined : {'Retry-After': retryAfter},
      }),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      code: 'BACKEND_STARTING',
      retryAfterSeconds: null,
    });
  });

  it('maps BACKEND_BLOCKED and parses its activation blockers from detail', async () => {
    const detail = [
      {capability: 'persistent-rci-session:write', reason: 'not-granted'},
      {capability: 'persistent-rci-session:write', reason: 'prerequisite-unavailable',
        prerequisite: 'controller-token'},
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code: 'BACKEND_BLOCKED', message: 'x', detail}}, {
        status: 503,
        headers: {'Retry-After': '2'},
      }),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toBeInstanceOf(BackendBlocked);
    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      id: 'stats',
      code: 'BACKEND_BLOCKED',
      retryAfterSeconds: 2,
      blockers: detail,
    });
  });

  it('maps BACKEND_BLOCKED with a malformed detail to an empty blocker list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code: 'BACKEND_BLOCKED', message: 'x', detail: 'nope'}}, {status: 503}),
    );

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      code: 'BACKEND_BLOCKED',
      blockers: [],
    });
  });

  it('passes non-envelope error responses through to the caller', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', {status: 500}));

    const res = await client(undefined, fetchImpl).fetch('stats');

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
  });

  it('passes an unknown error envelope through as a plugin response', async () => {
    const body = JSON.stringify({error: {code: 'PLUGIN_SPECIFIC', message: 'plugin error'}});
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, {status: 500}));

    const response = await client(undefined, fetchImpl).fetch('stats');

    expect(response.ok).toBe(false);
    expect(await response.text()).toBe(body);
  });

  it('returns a daemon-shaped plugin error when the platform marker is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(BAD_REQUEST_COLLISION_BODY, {status: 422}));

    const response = await client(undefined, fetchImpl).fetch('stats');

    expect(response.status).toBe(422);
    await expect(response.text()).resolves.toBe(BAD_REQUEST_COLLISION_BODY);
  });

  it('maps a daemon-shaped error when the platform marker is present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(markedDaemonError(BAD_REQUEST_COLLISION, {status: 422}));

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      name: 'BackendError',
      code: 'BAD_REQUEST',
      status: 422,
    });
  });

  it('keeps marked redirected errors as plugin responses for fetch and call', async () => {
    const redirectedResponse = (): Response => {
      const response = markedDaemonError(BAD_REQUEST_COLLISION, {status: 422});

      Object.defineProperty(response, 'redirected', {value: true});

      return response;
    };
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(redirectedResponse()));
    const backend = client(undefined, fetchImpl);

    const response = await backend.fetch('stats');

    expect(response.redirected).toBe(true);
    await expect(response.text()).resolves.toBe(BAD_REQUEST_COLLISION_BODY);
    await expect(backend.call('stats')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 422,
      details: BAD_REQUEST_COLLISION_BODY,
    });
  });

  it('uses INTERNAL for a marked daemon error with an unknown code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(markedDaemonError(
      {error: {code: 'FUTURE_PLATFORM_CODE', message: 'Platform failed', detail: 'unmapped'}},
      {status: 502},
    ));

    await expect(client(undefined, fetchImpl).fetch('stats')).rejects.toMatchObject({
      name: 'BackendError',
      code: 'INTERNAL',
      message: 'Platform failed',
      status: 502,
      details: 'unmapped',
    });
  });
});

describe('createBackendClient.call', () => {
  it('selects JSON, text, or Blob from Content-Type', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"message":"hello"}', {headers: {'content-type': 'application/vnd.mndw+json'}}),
      )
      .mockResolvedValueOnce(new Response('plain output', {headers: {'content-type': 'text/plain; charset=utf-8'}}))
      .mockResolvedValueOnce(new Response('binary output', {headers: {'content-type': 'application/octet-stream'}}));
    const backend = client(undefined, fetchImpl);

    await expect(backend.call('stats')).resolves.toEqual({message: 'hello'});
    await expect(backend.call('stats')).resolves.toBe('plain output');

    const blob = await backend.call('stats');

    expect(blob).toBeInstanceOf(Blob);

    if (!(blob instanceof Blob)) {
      throw new Error('Expected a Blob response');
    }

    await expect(blob.text()).resolves.toBe('binary output');
  });

  it('honors explicit JSON, text, and Blob formats', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"value":1}', {headers: {'content-type': 'text/plain'}}))
      .mockResolvedValueOnce(new Response('{"value":2}', {headers: {'content-type': 'application/json'}}))
      .mockResolvedValueOnce(new Response('raw', {headers: {'content-type': 'text/plain'}}));
    const backend = client(undefined, fetchImpl);

    await expect(backend.call<{value: number}>('stats', {as: 'json'})).resolves.toEqual({value: 1});
    await expect(backend.call('stats', {as: 'text'})).resolves.toBe('{"value":2}');

    const blob = await backend.call('stats', {as: 'blob'});

    expect(blob).toBeInstanceOf(Blob);
    await expect(blob.text()).resolves.toBe('raw');
  });

  it('rejects a plugin non-OK response with HTTP_ERROR and the response text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('plugin failed', {status: 422}));

    await expect(client(undefined, fetchImpl).call('stats')).rejects.toMatchObject({
      name: 'BackendError',
      code: 'HTTP_ERROR',
      status: 422,
      id: 'stats',
      retryable: false,
      details: 'plugin failed',
    });
  });

  it('keeps a daemon-shaped plugin error as HTTP_ERROR without the platform marker', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(BAD_REQUEST_COLLISION_BODY, {status: 422}));

    await expect(client(undefined, fetchImpl).call('stats')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 422,
      details: BAD_REQUEST_COLLISION_BODY,
    });
  });

  it('maps a marked daemon error before call decodes its body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(markedDaemonError(BAD_REQUEST_COLLISION, {status: 422}));

    await expect(client(undefined, fetchImpl).call('stats')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 422,
    });
  });

  it('rejects malformed selected JSON with INVALID_RESPONSE', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('not-json', {status: 200, headers: {'content-type': 'application/json'}}),
    );

    await expect(client(undefined, fetchImpl).call('stats')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
      id: 'stats',
    });
  });

  it('propagates native abort errors without wrapping them', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockRejectedValue(abort);

    await expect(client(undefined, fetchImpl).call('stats')).rejects.toBe(abort);
  });

  it.each(
    [
      ['BACKEND_BUSY', true],
      ['BACKEND_STARTING', true],
      ['SCRIPT_TIMEOUT', true],
      ['SCRIPT_FAILED', false],
      ['UNAUTHORIZED', false],
    ] as const,
  )('reports retryable=%s for %s', async (code, retryable) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      markedDaemonError({error: {code, message: 'platform failure'}}, {status: 500}),
    );

    await expect(client(undefined, fetchImpl).call('stats')).rejects.toMatchObject({code, retryable});
  });

  it('uses BackendErrorCode for the complete public code union', () => {
    const codes: BackendErrorCode[] = [
      'UNKNOWN_ID',
      'BACKEND_NOT_DECLARED',
      'NOT_APPROVED',
      'DISABLED',
      'TRANSPORT_MISMATCH',
      'BACKEND_STARTING',
      'BACKEND_UNAVAILABLE',
      'BACKEND_INCOMPATIBLE',
      'BACKEND_MAINTENANCE',
      'BACKEND_BLOCKED',
      'BAD_GATEWAY',
      'STATUS_QUERY_FAILED',
      'ROUTE_NOT_FOUND',
      'BAD_REQUEST',
      'INTERNAL',
      'REQUEST_TIMEOUT',
      'SCRIPT_FAILED',
      'SCRIPT_TIMEOUT',
      'SERVER_BUSY',
      'BACKEND_BUSY',
      'BACKEND_BODY_TOO_LARGE',
      'BACKEND_OUTPUT_TOO_LARGE',
      'CSRF_REQUIRED',
      'UNAUTHORIZED',
      'HTTP_ERROR',
      'INVALID_RESPONSE',
    ];

    expect(codes).toHaveLength(26);
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
    const socket = client({enabled: false}).socket('term');

    expect(socket.readyState).toBe(3);
    expect(BackendSocketCloseCode.disabled).toBeGreaterThanOrEqual(4000);
    expect(BackendSocketCloseCode.disabled).toBeLessThanOrEqual(4999);

    return new Promise<void>((resolve) => {
      socket.addEventListener('close', (event) => {
        expect(event).toMatchObject({
          code: BackendSocketCloseCode.disabled,
          reason: expect.stringContaining('disabled'),
        });
        resolve();
      }, {once: true});
    });
  });

  it('reports pending approval through the closed socket onclose handler', async () => {
    const socket = client({approval: 'pending'}).socket('term');
    const close = new Promise<CloseEvent>((resolve) => {
      socket.onclose = resolve;
    });

    expect(socket.readyState).toBe(3);
    await expect(close).resolves.toMatchObject({
      code: BackendSocketCloseCode.notApproved,
      reason: expect.stringContaining('approved'),
    });
  });
});

describe('createBackendClient.status', () => {
  it('accepts and strips unrelated top-level fields', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'service',
          state: 'ready',
          retryAfterSeconds: null,
          futureField: true,
        }),
        {status: 200},
      ),
    );

    await expect(client(undefined, fetchImpl).status()).resolves.toEqual({
      kind: 'service',
      state: 'ready',
      retryAfterSeconds: null,
    });
  });

  it('queries the bound plugin status URL without descriptor fast paths', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({kind: 'service', state: 'disabled', retryAfterSeconds: null}), {status: 200}),
    );
    const backend = client({enabled: false}, fetchImpl);

    await expect(backend.status()).resolves.toMatchObject({state: 'disabled'});
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://host/api/plugins/demo/_mndw/status',
      {method: 'GET', signal: undefined},
    );
  });

  it('parses blocked and preserves unknown blocker codes', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'service',
          state: 'blocked',
          retryAfterSeconds: 0,
          blockers: [{capability: 'persistent-rci-session:read', reason: 'future-reason', prerequisite: 'future-code'}],
        }),
        {status: 200},
      ),
    );

    await expect(client(undefined, fetchImpl).status()).resolves.toEqual({
      kind: 'service',
      state: 'blocked',
      retryAfterSeconds: 0,
      blockers: [{capability: 'persistent-rci-session:read', reason: 'future-reason', prerequisite: 'future-code'}],
    });
  });

  it.each(
    [
      'ready',
      'starting',
      'unavailable',
      'maintenance',
      'disabled',
      'not-approved',
    ] as const,
  )('parses %s status', async (state) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({kind: 'exec', state, retryAfterSeconds: null}), {status: 200}),
    );

    await expect(client(undefined, fetchImpl).status()).resolves.toMatchObject({kind: 'exec', state});
  });

  it('parses incompatible protocol fields', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'service',
          state: 'incompatible',
          retryAfterSeconds: null,
          requiredProtocol: 2,
          supportedProtocols: [1],
        }),
        {status: 200},
      ),
    );

    await expect(client(undefined, fetchImpl).status()).resolves.toMatchObject({
      state: 'incompatible',
      requiredProtocol: 2,
      supportedProtocols: [1],
    });
  });

  it('rejects blocked status carrying incompatible protocol fields', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'service',
          state: 'blocked',
          retryAfterSeconds: null,
          blockers: [{capability: 'persistent-rci-session:read', reason: 'needs session'}],
          requiredProtocol: 2,
        }),
        {status: 200},
      ),
    );

    await expect(client(undefined, fetchImpl).status()).rejects.toBeInstanceOf(BackendStatusQueryError);
  });

  it('rejects incompatible status carrying blockers', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'service',
          state: 'incompatible',
          retryAfterSeconds: null,
          requiredProtocol: 2,
          supportedProtocols: [1],
          blockers: [],
        }),
        {status: 200},
      ),
    );

    await expect(client(undefined, fetchImpl).status()).rejects.toBeInstanceOf(BackendStatusQueryError);
  });

  it('rejects plain status carrying protocol fields', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'service',
          state: 'ready',
          retryAfterSeconds: null,
          supportedProtocols: [1],
        }),
        {status: 200},
      ),
    );

    await expect(client(undefined, fetchImpl).status()).rejects.toBeInstanceOf(BackendStatusQueryError);
  });

  it('rejects status missing retryAfterSeconds', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({kind: 'service', state: 'ready'}), {status: 200}),
    );

    await expect(client(undefined, fetchImpl).status()).rejects.toBeInstanceOf(BackendStatusQueryError);
  });

  it.each([
    {state: 'blocked', blockers: undefined},
    {state: 'blocked', blockers: []},
    {state: 'blocked', blockers: [{capability: 'bad', reason: 'x'}]},
    {state: 'blocked', blockers: [{capability: 'persistent-rci-session:read', reason: ''}]},
    {state: 'blocked', blockers: [{capability: 'persistent-rci-session:read', reason: 'x', prerequisite: ''}]},
    {state: 'ready', blockers: [{capability: 'persistent-rci-session:read', reason: 'x'}]},
    {state: 'incompatible', requiredProtocol: 1},
    {state: 'ready', retryAfterSeconds: -1},
    {state: 'ready', retryAfterSeconds: 1.5},
    {state: 'unknown', retryAfterSeconds: null},
  ])('rejects malformed status payload %#', async (payload) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({kind: 'service', retryAfterSeconds: null, ...payload}), {status: 200}),
    );

    await expect(client(undefined, fetchImpl).status()).rejects.toBeInstanceOf(BackendStatusQueryError);
  });

  it('propagates abort and network errors', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const abortedFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(abort);
    const networkError = new Error('network');
    const failedFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(networkError);

    await expect(client(undefined, abortedFetch).status()).rejects.toBe(abort);
    await expect(client(undefined, failedFetch).status()).rejects.toBe(networkError);
  });

  it.each([404, 500])('wraps HTTP %s as BackendStatusQueryError', async (status) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('failure', {status}));

    await expect(client(undefined, fetchImpl).status()).rejects.toMatchObject({
      name: 'BackendStatusQueryError',
      httpStatus: status,
    });
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
