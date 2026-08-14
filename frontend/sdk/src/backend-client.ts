import type {PluginPermission} from './manifest.js';

/**
 * Typed backend client handed to plugins as `context.backend`.
 * It resolves HTTP and WebSocket route ids from the daemon's capability snapshot and
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
 * Plugins handle one error family either way. `status()` is separate: it is a
 * live, passive, bound-plugin query and is not a readiness probe.
 */

export type BackendApprovalStatus = 'approved' | 'pending' | 'denied';

export type BackendRouteTransport = 'http' | 'websocket';

export interface BackendRouteDescriptor {
  transport: BackendRouteTransport;
  path: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  protocols?: string[];
}

/** Per-plugin backend snapshot from `GET /api/mgmt/list`. */
export interface BackendDescriptor {
  /** One command-free route map shared by exec and service backends. */
  routes: Record<string, BackendRouteDescriptor>;
  approval: BackendApprovalStatus;
  enabled: boolean;
}

export type BackendStatusState =
  | 'ready'
  | 'starting'
  | 'unavailable'
  | 'incompatible'
  | 'maintenance'
  | 'blocked'
  | 'disabled'
  | 'not-approved';

export interface BackendBlocker {
  permission: PluginPermission;
  reason: string;
  prerequisite?: string;
}

interface BackendStatusBase {
  kind: 'exec' | 'service';
  retryAfterSeconds: number | null;
}

export type BackendStatus =
  | (BackendStatusBase & {state: 'blocked'; blockers: BackendBlocker[]})
  | (BackendStatusBase & {
    state: 'incompatible';
    requiredProtocol: number;
    supportedProtocols: number[];
  })
  | (BackendStatusBase & {state: Exclude<BackendStatusState, 'blocked' | 'incompatible'>});

export interface BackendStatusOptions {
  signal?: AbortSignal;
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
  /** Query live daemon-owned backend availability without executing a backend route. */
  status(options?: BackendStatusOptions): Promise<BackendStatus>;
}

/** Returns true for an intentional daemon maintenance close; callers must show
 * an explicit reconnect affordance and never silently recreate the socket. */
export const isBackendMaintenanceClose = (event: Pick<CloseEvent, 'code' | 'reason'>): boolean => {
  return event.code === 1012 && event.reason.toLowerCase() === 'mndw updating';
};

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

export class BackendTransportMismatch extends Error {
  public readonly code = 'TRANSPORT_MISMATCH';

  constructor(public readonly id: string, public readonly expected: BackendRouteTransport) {
    super(`Backend route "${id}" is not an ${expected} route`);
    this.name = 'BackendTransportMismatch';
  }
}

export class BackendStarting extends Error {
  public readonly daemonCode = 'BACKEND_STARTING';

  constructor(public readonly id: string, public readonly retryAfterSeconds: number | null) {
    super(`Backend "${id}" is starting`);
    this.name = 'BackendStarting';
  }
}

export class BackendUnavailable extends Error {
  public readonly daemonCode = 'BACKEND_UNAVAILABLE';

  constructor(public readonly id: string) {
    super(`Backend "${id}" is unavailable`);
    this.name = 'BackendUnavailable';
  }
}

export class BackendIncompatible extends Error {
  public readonly daemonCode = 'BACKEND_INCOMPATIBLE';

  constructor(public readonly id: string) {
    super(`Backend "${id}" is incompatible`);
    this.name = 'BackendIncompatible';
  }
}

export class BackendMaintenance extends Error {
  public readonly daemonCode = 'BACKEND_MAINTENANCE';

  constructor(public readonly id: string, public readonly retryAfterSeconds: number | null) {
    super(`Backend "${id}" is under maintenance`);
    this.name = 'BackendMaintenance';
  }
}

export class BackendBadGateway extends Error {
  public readonly daemonCode = 'BAD_GATEWAY';

  constructor(public readonly id: string) {
    super(`Backend "${id}" returned a bad gateway response`);
    this.name = 'BackendBadGateway';
  }
}

export class BackendStatusQueryError extends Error {
  public readonly code = 'STATUS_QUERY_FAILED';

  constructor(public readonly httpStatus: number | null, message: string) {
    super(message);
    this.name = 'BackendStatusQueryError';
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

const DAEMON_ERROR_CODES = new Set([
  'NOT_APPROVED',
  'DISABLED',
  'ROUTE_NOT_FOUND',
  'BACKEND_STARTING',
  'BACKEND_UNAVAILABLE',
  'BACKEND_INCOMPATIBLE',
  'BACKEND_MAINTENANCE',
  'BAD_GATEWAY',
]);

const parseRetryAfterSeconds = (response: Response): number | null => {
  const raw = response.headers.get('Retry-After');

  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }

  const value = Number(raw);

  return Number.isSafeInteger(value) ? value : null;
};

const parseNonNegativeInteger = (value: unknown, field: string): number | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${field}`);
  }

  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isPluginPermission = (value: unknown): value is PluginPermission => {
  return value === 'persistent-rci-session:read' || value === 'persistent-rci-session:write';
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean => {
  return Object.prototype.hasOwnProperty.call(value, key);
};

const parseBackendStatusPayload: (value: unknown) => BackendStatus = (value) => {
  if (!isRecord(value)) {
    throw new Error('Invalid backend status payload');
  }

  const kind = value.kind;

  if (kind !== 'exec' && kind !== 'service') {
    throw new Error('Invalid backend status kind');
  }

  const state = value.state;
  const states: BackendStatusState[] = [
    'ready',
    'starting',
    'unavailable',
    'incompatible',
    'maintenance',
    'blocked',
    'disabled',
    'not-approved',
  ];

  if (typeof state !== 'string' || !states.includes(state as BackendStatusState)) {
    throw new Error('Invalid backend status state');
  }

  const parsedState = state as BackendStatusState;

  const retryAfterSeconds = parseNonNegativeInteger(value.retryAfterSeconds, 'retryAfterSeconds');

  if (!hasOwn(value, 'retryAfterSeconds')) {
    throw new Error('Missing retryAfterSeconds');
  }

  if (parsedState === 'blocked') {
    if (!Array.isArray(value.blockers) || value.blockers.length === 0) {
      throw new Error('Invalid blockers');
    }

    if (hasOwn(value, 'requiredProtocol') || hasOwn(value, 'supportedProtocols')) {
      throw new Error('Invalid blocked status fields');
    }

    const blockers = value.blockers.map((rawBlocker): BackendBlocker => {
      if (!isRecord(rawBlocker) || !isPluginPermission(rawBlocker.permission)) {
        throw new Error('Invalid blocker permission');
      }

      if (typeof rawBlocker.reason !== 'string' || rawBlocker.reason.length === 0) {
        throw new Error('Invalid blocker reason');
      }

      if (hasOwn(rawBlocker, 'prerequisite')
        && (typeof rawBlocker.prerequisite !== 'string' || rawBlocker.prerequisite.length === 0)) {
        throw new Error('Invalid blocker prerequisite');
      }

      const blocker: BackendBlocker = {
        permission: rawBlocker.permission,
        reason: rawBlocker.reason,
      };

      if (typeof rawBlocker.prerequisite === 'string') {
        blocker.prerequisite = rawBlocker.prerequisite;
      }

      return blocker;
    });

    return {kind, state: parsedState, retryAfterSeconds, blockers};
  }

  if (parsedState === 'incompatible') {
    const requiredProtocol = value.requiredProtocol;
    const supportedProtocols = value.supportedProtocols;

    if (typeof requiredProtocol !== 'number'
      || !Number.isSafeInteger(requiredProtocol)
      || !Array.isArray(supportedProtocols)
      || !supportedProtocols.every((candidate): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate))) {
      throw new Error('Invalid incompatible status fields');
    }

    if (hasOwn(value, 'blockers')) {
      throw new Error('Invalid incompatible status fields');
    }

    return {
      kind,
      state: parsedState,
      retryAfterSeconds,
      requiredProtocol,
      supportedProtocols,
    };
  }

  if (hasOwn(value, 'blockers') || hasOwn(value, 'requiredProtocol') || hasOwn(value, 'supportedProtocols')) {
    throw new Error('Invalid backend status variant fields');
  }

  return {kind, state: parsedState, retryAfterSeconds};
};

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
// through unchanged so plugins still see their command's own error output.
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

  if (code === 'BACKEND_STARTING') {
    throw new BackendStarting(id, parseRetryAfterSeconds(res));
  }

  if (code === 'BACKEND_UNAVAILABLE') {
    throw new BackendUnavailable(id);
  }

  if (code === 'BACKEND_INCOMPATIBLE') {
    throw new BackendIncompatible(id);
  }

  if (code === 'BACKEND_MAINTENANCE') {
    throw new BackendMaintenance(id, parseRetryAfterSeconds(res));
  }

  if (code === 'BAD_GATEWAY') {
    throw new BackendBadGateway(id);
  }

  throw new BackendUnknownId(id);
};

const doFetch = async (
  ctx: ClientContext,
  binding: BackendRouteDescriptor,
  id: string,
  options: BackendFetchOptions,
): Promise<Response> => {
  const url = `${ctx.origin}/api/plugins/${ctx.pluginName}/${binding.path}${buildQuery(options.query)}`;
  const headers = new Headers(options.headers);

  if (binding.method !== 'GET' && binding.method !== 'HEAD') {
    headers.set('X-Mndw-Csrf', '1');
  }

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
      const binding = descriptor.routes[id];

      if (!binding) {
        throw new BackendUnknownId(id);
      }

      if (binding.transport !== 'http' || !binding.method) {
        throw new BackendTransportMismatch(id, 'http');
      }

      const blocked = gate(descriptor, id);

      if (blocked) {
        return Promise.reject(blocked);
      }

      return doFetch(ctx, binding, id, options);
    },

    socket(id: string, options: BackendSocketOptions = {}): WebSocket {
      const binding = descriptor.routes[id];

      if (!binding) {
        throw new BackendUnknownId(id);
      }

      if (binding.transport !== 'websocket') {
        throw new BackendTransportMismatch(id, 'websocket');
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

    status(options: BackendStatusOptions = {}): Promise<BackendStatus> {
      const url = `${ctx.origin}/api/plugins/${ctx.pluginName}/_mndw/status`;

      return ctx.fetchImpl(url, {method: 'GET', signal: options.signal}).then(async (response) => {
        if (!response.ok) {
          throw new BackendStatusQueryError(
            response.status,
            `Backend status query failed with HTTP ${response.status}`,
          );
        }

        try {
          return parseBackendStatusPayload(await response.json());
        } catch (error) {
          if (error instanceof BackendStatusQueryError) {
            throw error;
          }

          throw new BackendStatusQueryError(response.status, 'Backend status response is invalid');
        }
      });
    },
  };
}
