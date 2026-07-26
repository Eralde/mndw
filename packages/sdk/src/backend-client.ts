/**
 * Typed backend client handed to plugins as `context.backend`.
 * It resolves endpoint and websocket ids from the daemon's capability snapshot and
 * applies the same approval and enabled checks before issuing a request.
 *
 * Ids resolve locally from a descriptor snapshot taken from `GET /api/mgmt/list`,
 * no per-call lookup. Two error layers:
 *  - client-side pre-check from the snapshot - a typo (`BackendUnknownId`) throws synchronously;
 *    a known-unapproved / disabled binding rejects fast (`BackendNotApproved` / `BackendDisabled`);
 *  - the daemon is authoritative - its structured error envelope codes
 *    `NOT_APPROVED` / `DISABLED` / `ROUTE_NOT_FOUND` map onto the same
 *    typed errors when state changed after load.
 *
 * Plugins handle one error family either way.
 */

export type BackendApprovalStatus = 'approved' | 'pending' | 'denied';

export interface BackendEndpointDescriptor {
  method: string;
  path: string;
}

export interface BackendWebSocketDescriptor {
  path: string;
  protocols?: string[];
}

/** Per-plugin backend snapshot from `GET /api/mgmt/list`. */
export interface BackendDescriptor {
  endpoints: Record<string, BackendEndpointDescriptor>;
  websockets: Record<string, BackendWebSocketDescriptor>;
  approval: BackendApprovalStatus;
  enabled: boolean;
  public: boolean;
}

export interface BackendFetchOptions {
  query?: Record<string, string | number | boolean>;
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface BackendSocketOptions {
  protocols?: string[];
}

export interface BackendClient {
  /** Resolve `id` to its URL + method and issue the request. Throws `BackendUnknownId` synchronously. */
  fetch(id: string, options?: BackendFetchOptions): Promise<Response>;
  /** Open a websocket to the declared target. Throws synchronously on a bad/blocked id. */
  socket(id: string, options?: BackendSocketOptions): WebSocket;
}

// ------------------------------------
// Typed errors
// ------------------------------------

export class BackendUnknownId extends Error {
  public readonly code = 'UNKNOWN_ID';

  constructor(public readonly id: string) {
    super(`Unknown backend binding id: "${id}"`);
    this.name = 'BackendUnknownId';
  }
}

export class BackendNotApproved extends Error {
  public readonly code = 'NOT_APPROVED';

  constructor(public readonly id: string) {
    super(`Backend "${id}" is not approved`);
    this.name = 'BackendNotApproved';
  }
}

export class BackendDisabled extends Error {
  public readonly code = 'DISABLED';

  constructor(public readonly id: string) {
    super(`Backend "${id}" is disabled`);
    this.name = 'BackendDisabled';
  }
}

// ------------------------------------
// Implementation
// ------------------------------------

/** Injectable environment; defaults to browser globals. Tests pass mocks. */
export interface BackendClientDeps {
  fetch?: typeof globalThis.fetch;
  WebSocketCtor?: typeof WebSocket;
  /** Absolute origin (e.g. `https://host:99`) used to derive the ws:// scheme and host. */
  origin?: string;
}

const DAEMON_ERROR_CODES = new Set(['NOT_APPROVED', 'DISABLED', 'ROUTE_NOT_FOUND']);

const buildQuery = (query: BackendFetchOptions['query']): string => {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }

  const serialized = params.toString();

  return serialized ? `?${serialized}` : '';
};

const isPlainBody = (body: unknown): body is Record<string, unknown> | unknown[] => {
  if (body === null || typeof body !== 'object') {
    return false;
  }

  return !(
    body instanceof FormData
    || body instanceof Blob
    || body instanceof ArrayBuffer
    || body instanceof URLSearchParams
    || body instanceof ReadableStream
  );
};

const wsScheme = (origin: string): string => (origin.startsWith('https:') ? 'wss:' : 'ws:');

interface ClientContext {
  pluginName: string;
  descriptor: BackendDescriptor;
  fetchImpl: typeof globalThis.fetch;
  WebSocketCtor: typeof WebSocket;
  origin: string;
}

// Reject fast for a known-but-blocked binding. Returns the typed error, or null when usable.
const gate = (descriptor: BackendDescriptor, id: string): BackendNotApproved | BackendDisabled | null => {
  if (!descriptor.enabled) {
    return new BackendDisabled(id);
  }

  if (descriptor.approval !== 'approved') {
    return new BackendNotApproved(id);
  }

  return null;
};

// Map the daemon's structured error envelope onto the typed errors. Non-matching responses pass
// through unchanged so plugins still see their script's own error output.
const mapResponse = async (id: string, res: Response): Promise<Response> => {
  if (res.ok) {
    return res;
  }

  let code: string | undefined;

  try {
    const payload = await res.clone().json() as {error?: {code?: string}};

    code = payload.error?.code;
  } catch {
    return res;
  }

  if (!code || !DAEMON_ERROR_CODES.has(code)) {
    return res;
  }

  if (code === 'DISABLED') {
    throw new BackendDisabled(id);
  }

  if (code === 'NOT_APPROVED') {
    throw new BackendNotApproved(id);
  }

  throw new BackendUnknownId(id);
};

const doFetch = async (
  ctx: ClientContext,
  binding: BackendEndpointDescriptor,
  id: string,
  options: BackendFetchOptions,
): Promise<Response> => {
  const url = `${ctx.origin}/api/plugins/${ctx.pluginName}/${binding.path}${buildQuery(options.query)}`;
  const headers = new Headers(options.headers);
  let body: BodyInit | null | undefined;

  if (options.body !== undefined && options.body !== null) {
    if (isPlainBody(options.body)) {
      body = JSON.stringify(options.body);

      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    } else {
      body = options.body;
    }
  }

  const res = await ctx.fetchImpl(url, {method: binding.method, headers, body, signal: options.signal});

  return mapResponse(id, res);
};

export function createBackendClient(
  pluginName: string,
  descriptor: BackendDescriptor,
  deps: BackendClientDeps = {},
): BackendClient {
  const ctx: ClientContext = {
    pluginName,
    descriptor,
    fetchImpl: deps.fetch ?? globalThis.fetch.bind(globalThis),
    WebSocketCtor: deps.WebSocketCtor ?? globalThis.WebSocket,
    origin: deps.origin ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost'),
  };

  return {
    fetch(id: string, options: BackendFetchOptions = {}): Promise<Response> {
      const binding = descriptor.endpoints[id];

      if (!binding) {
        throw new BackendUnknownId(id);
      }

      const blocked = gate(descriptor, id);

      if (blocked) {
        return Promise.reject(blocked);
      }

      return doFetch(ctx, binding, id, options);
    },

    socket(id: string, options: BackendSocketOptions = {}): WebSocket {
      const binding = descriptor.websockets[id];

      if (!binding) {
        throw new BackendUnknownId(id);
      }

      const blocked = gate(descriptor, id);

      if (blocked) {
        throw blocked;
      }

      const url = `${wsScheme(ctx.origin)}//${ctx.origin.replace(/^[a-z]+:\/\//, '')}`
        + `/ws/plugins/${ctx.pluginName}/${binding.path}`;
      const protocols = options.protocols ?? binding.protocols;

      return new ctx.WebSocketCtor(url, protocols);
    },
  };
}
