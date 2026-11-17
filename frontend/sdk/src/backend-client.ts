import {z} from 'zod';
import {persistentRciPermissionSchema} from './permissions.js';

/**
 * Typed backend client handed to plugins as `context.backend`.
 * It resolves HTTP and WebSocket route ids from the daemon's capability snapshot and
 * applies the same approval and enabled checks before issuing a request.
 *
 * Ids resolve locally from a descriptor snapshot taken from `GET /api/mgmt/list`,
 * no per-call lookup. Two error layers:
 *  - client-side pre-check from the snapshot - a typo (`BackendUnknownId`) throws synchronously;
 *    a known-unapproved / disabled binding rejects fast (`BackendNotApproved` / `BackendDisabled`);
 *  - the daemon is authoritative for responses it marks as platform errors - its structured error envelope codes
 *    `NOT_APPROVED`, `DISABLED`, `ROUTE_NOT_FOUND`, `BACKEND_STARTING`,
 *    `BACKEND_UNAVAILABLE`, `BACKEND_INCOMPATIBLE`, `BACKEND_MAINTENANCE`,
 *    `BACKEND_BLOCKED`, and `BAD_GATEWAY` map onto the same typed errors when
 *    state changed after load.
 *
 * Plugins handle one error family either way. `status()` is separate: it is a
 * live, passive, bound-plugin query and is not a readiness probe.
 */

export type BackendApprovalStatus = 'approved' | 'pending' | 'denied';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const backendBlockerSchema = z.object({
  permission: persistentRciPermissionSchema,
  reason: z.string().min(1),
  prerequisite: z.string().min(1)
    .optional(),
});

const retryAfterSchema = z.number().int()
  .nonnegative()
  .nullable();

const blockedStatusSchema = z.object({
  kind: z.enum(['exec', 'service']),
  state: z.literal('blocked'),
  retryAfterSeconds: retryAfterSchema,
  blockers: z.array(backendBlockerSchema).min(1),
});

const incompatibleStatusSchema = z.object({
  kind: z.enum(['exec', 'service']),
  state: z.literal('incompatible'),
  retryAfterSeconds: retryAfterSchema,
  requiredProtocol: z.number().int(),
  supportedProtocols: z.array(z.number().int()),
});

const plainStatusSchema = z.object({
  kind: z.enum(['exec', 'service']),
  state: z.enum(['ready', 'starting', 'unavailable', 'maintenance', 'disabled', 'not-approved']),
  retryAfterSeconds: retryAfterSchema,
});

const rejectVariantOnlyFields = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }

  // Every state forbids all three variant-only fields except the two that own them: `blocked`
  // carries `blockers`, `incompatible` carries the protocol pair.
  const forbiddenByState: Record<string, string[]> = {
    blocked: ['requiredProtocol', 'supportedProtocols'],
    incompatible: ['blockers'],
  };

  const forbidden = forbiddenByState[String(value.state)]
    ?? ['blockers', 'requiredProtocol', 'supportedProtocols'];

  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('backend status contains fields for a different variant');
  }

  return value;
};

const backendStatusSchema = z.preprocess(
  rejectVariantOnlyFields,
  z.discriminatedUnion('state', [blockedStatusSchema, incompatibleStatusSchema, plainStatusSchema]),
);

export type BackendBlocker = z.infer<typeof backendBlockerSchema>;
export type BackendStatus = z.infer<typeof backendStatusSchema>;
export type BackendStatusState = BackendStatus['state'];

export type BackendRouteTransport = 'http' | 'websocket';

export interface BackendRouteDescriptor {
  transport: BackendRouteTransport;
  path: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  protocols?: string[];
}

/**
 * Host-assembled input bundle for a plugin's backend client. The route map comes from the
 * daemon descriptor; approval and enabled state come from the management-list entry.
 */
export interface BackendDescriptor {
  /** One command-free route map shared by exec and service backends. */
  routes: Record<string, BackendRouteDescriptor>;
  approval: BackendApprovalStatus;
  enabled: boolean;
}

export interface BackendStatusOptions {
  signal?: AbortSignal;
}

export interface BackendFetchOptions {
  query?: Record<string, string | number | boolean>;
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface BackendCallOptions extends BackendFetchOptions {
  as?: 'json' | 'text' | 'blob';
}

export interface BackendSocketOptions {
  protocols?: string[];
}

export interface BackendClient {
  /** Resolve and issue the request. Returns plugin responses, including non-OK; throws for marked platform errors. */
  fetch(id: string, options?: BackendFetchOptions): Promise<Response>;
  /** Fetch and decode a route response, rejecting plugin-owned non-OK responses and marked platform errors. */
  call<T = unknown>(id: string, options: BackendCallOptions & {as: 'json'}): Promise<T>;
  call(id: string, options: BackendCallOptions & {as: 'text'}): Promise<string>;
  call(id: string, options: BackendCallOptions & {as: 'blob'}): Promise<Blob>;
  call<T = unknown>(id: string, options?: BackendCallOptions): Promise<T | string | Blob>;
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

export type BackendErrorCode =
  | 'UNKNOWN_ID'
  | 'NOT_APPROVED'
  | 'DISABLED'
  | 'TRANSPORT_MISMATCH'
  | 'BACKEND_STARTING'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_INCOMPATIBLE'
  | 'BACKEND_MAINTENANCE'
  | 'BACKEND_BLOCKED'
  | 'BAD_GATEWAY'
  | 'STATUS_QUERY_FAILED'
  | 'ROUTE_NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INTERNAL'
  | 'SERVER_BUSY'
  | 'REQUEST_TIMEOUT'
  | 'SCRIPT_FAILED'
  | 'SCRIPT_TIMEOUT'
  | 'BACKEND_BUSY'
  | 'BACKEND_BODY_TOO_LARGE'
  | 'BACKEND_OUTPUT_TOO_LARGE'
  | 'CSRF_REQUIRED'
  | 'UNAUTHORIZED'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE';

interface BackendErrorOptions {
  status?: number;
  retryable?: boolean;
  details?: unknown;
}

const RETRYABLE_CODES = new Set<BackendErrorCode>([
  'BACKEND_BUSY',
  'BACKEND_STARTING',
  'BACKEND_UNAVAILABLE',
  'BACKEND_MAINTENANCE',
  'BAD_GATEWAY',
  'SERVER_BUSY',
  'REQUEST_TIMEOUT',
  'SCRIPT_TIMEOUT',
  'STATUS_QUERY_FAILED',
]);

const isRetryable = (code: BackendErrorCode, status?: number): boolean => {
  if (code === 'HTTP_ERROR') {
    return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
  }

  return RETRYABLE_CODES.has(code);
};

export class BackendError extends Error {
  public readonly id: string | undefined;
  public readonly code: BackendErrorCode;
  public readonly status: number | undefined;
  public readonly retryable: boolean;
  public readonly details: unknown;

  constructor(message: string, code: BackendErrorCode, id?: string, options: BackendErrorOptions = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.id = id;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryable(code, options.status);
    this.details = options.details;
  }
}

export class BackendUnknownId extends BackendError {
  public override readonly code: 'UNKNOWN_ID' | 'ROUTE_NOT_FOUND';

  constructor(id: string, options: BackendErrorOptions & {code?: 'UNKNOWN_ID' | 'ROUTE_NOT_FOUND'} = {}) {
    const code = options.code ?? 'UNKNOWN_ID';

    super(`Unknown backend binding id: "${id}"`, code, id, options);
    this.code = code;
    this.name = 'BackendUnknownId';
  }
}

export class BackendNotApproved extends BackendError {
  public override readonly code = 'NOT_APPROVED';

  constructor(id: string, options: BackendErrorOptions = {}) {
    super(`Backend "${id}" is not approved`, 'NOT_APPROVED', id, options);
    this.name = 'BackendNotApproved';
  }
}

export class BackendDisabled extends BackendError {
  public override readonly code = 'DISABLED';

  constructor(id: string, options: BackendErrorOptions = {}) {
    super(`Backend "${id}" is disabled`, 'DISABLED', id, options);
    this.name = 'BackendDisabled';
  }
}

export class BackendTransportMismatch extends BackendError {
  public override readonly code = 'TRANSPORT_MISMATCH';

  constructor(id: string, public readonly expected: BackendRouteTransport, options: BackendErrorOptions = {}) {
    super(`Backend route "${id}" is not an ${expected} route`, 'TRANSPORT_MISMATCH', id, options);
    this.name = 'BackendTransportMismatch';
  }
}

export class BackendStarting extends BackendError {
  public override readonly code = 'BACKEND_STARTING';

  constructor(
    id: string,
    public readonly retryAfterSeconds: number | null,
    options: BackendErrorOptions = {},
  ) {
    super(`Backend "${id}" is starting`, 'BACKEND_STARTING', id, options);
    this.name = 'BackendStarting';
  }
}

export class BackendUnavailable extends BackendError {
  public override readonly code = 'BACKEND_UNAVAILABLE';

  constructor(id: string, options: BackendErrorOptions = {}) {
    super(`Backend "${id}" is unavailable`, 'BACKEND_UNAVAILABLE', id, options);
    this.name = 'BackendUnavailable';
  }
}

export class BackendIncompatible extends BackendError {
  public override readonly code = 'BACKEND_INCOMPATIBLE';

  constructor(id: string, options: BackendErrorOptions = {}) {
    super(`Backend "${id}" is incompatible`, 'BACKEND_INCOMPATIBLE', id, options);
    this.name = 'BackendIncompatible';
  }
}

export class BackendMaintenance extends BackendError {
  public override readonly code = 'BACKEND_MAINTENANCE';

  constructor(
    id: string,
    public readonly retryAfterSeconds: number | null,
    options: BackendErrorOptions = {},
  ) {
    super(`Backend "${id}" is under maintenance`, 'BACKEND_MAINTENANCE', id, options);
    this.name = 'BackendMaintenance';
  }
}

export class BackendBlocked extends BackendError {
  public override readonly code = 'BACKEND_BLOCKED';

  constructor(
    id: string,
    public readonly blockers: BackendBlocker[],
    public readonly retryAfterSeconds: number | null,
    options: BackendErrorOptions = {},
  ) {
    super(`Backend "${id}" is blocked on an unmet activation prerequisite`, 'BACKEND_BLOCKED', id, options);
    this.name = 'BackendBlocked';
  }
}

export class BackendBadGateway extends BackendError {
  public override readonly code = 'BAD_GATEWAY';

  constructor(id: string, options: BackendErrorOptions = {}) {
    super(`Backend "${id}" returned a bad gateway response`, 'BAD_GATEWAY', id, options);
    this.name = 'BackendBadGateway';
  }
}

export class BackendStatusQueryError extends BackendError {
  public override readonly code = 'STATUS_QUERY_FAILED';

  constructor(public readonly httpStatus: number | null, message: string) {
    super(message, 'STATUS_QUERY_FAILED', undefined, {status: httpStatus ?? undefined});
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

const parseRetryAfterSeconds = (response: Response): number | null => {
  const raw = response.headers.get('Retry-After');

  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }

  const value = Number(raw);

  return Number.isSafeInteger(value) ? value : null;
};

// The daemon's structured error envelope; `detail` is code-specific (e.g. the
// activation blockers carried by `BACKEND_BLOCKED`).
interface DaemonError {
  code?: string;
  message?: string;
  detail?: unknown;
}

// Parse the activation blockers a `BACKEND_BLOCKED` envelope carries in `detail`.
// A malformed or absent detail degrades to an empty list rather than throwing.
const parseBlockers = (detail: unknown): BackendBlocker[] => {
  const parsed = z.array(backendBlockerSchema).safeParse(detail);

  return parsed.success ? parsed.data : [];
};

// Single source of truth for the daemon's structured error codes: each maps to the typed error it
// throws. Membership (`code in ERROR_BY_CODE`) replaces a separate code Set — adding a code here is
// enough to both recognize and handle it.
type ErrorFactory = (id: string, res: Response, error: DaemonError, options: BackendErrorOptions) => BackendError;

const genericErrorFactory = (code: BackendErrorCode, fallback: string): ErrorFactory => {
  return (id, response, error, options) =>
    new BackendError(
      error.message ?? fallback,
      code,
      id,
      {...options, status: response.status},
    );
};

const ERROR_BY_CODE: Record<string, ErrorFactory> = {
  DISABLED: (id, _res, _error, options) => new BackendDisabled(id, options),
  NOT_APPROVED: (id, _res, _error, options) => new BackendNotApproved(id, options),
  ROUTE_NOT_FOUND: (id, _res, _error, options) => new BackendUnknownId(id, {...options, code: 'ROUTE_NOT_FOUND'}),
  BACKEND_STARTING: (id, res, _error, options) => new BackendStarting(id, parseRetryAfterSeconds(res), options),
  BACKEND_UNAVAILABLE: (id, _res, _error, options) => new BackendUnavailable(id, options),
  BACKEND_INCOMPATIBLE: (id, _res, _error, options) => new BackendIncompatible(id, options),
  BACKEND_MAINTENANCE: (id, res, _error, options) => new BackendMaintenance(id, parseRetryAfterSeconds(res), options),
  BACKEND_BLOCKED: (id, res, error, options) =>
    new BackendBlocked(id, parseBlockers(error.detail), parseRetryAfterSeconds(res), options),
  BAD_GATEWAY: (id, _res, _error, options) => new BackendBadGateway(id, options),
  BAD_REQUEST: genericErrorFactory('BAD_REQUEST', 'Backend request was rejected'),
  INTERNAL: genericErrorFactory('INTERNAL', 'Backend request failed'),
  SERVER_BUSY: genericErrorFactory('SERVER_BUSY', 'Backend request intake is busy'),
  REQUEST_TIMEOUT: genericErrorFactory('REQUEST_TIMEOUT', 'Backend request timed out'),
  SCRIPT_FAILED: genericErrorFactory('SCRIPT_FAILED', 'Backend script failed'),
  SCRIPT_TIMEOUT: genericErrorFactory('SCRIPT_TIMEOUT', 'Backend script timed out'),
  BACKEND_BUSY: genericErrorFactory('BACKEND_BUSY', 'Backend is busy'),
  BACKEND_BODY_TOO_LARGE: genericErrorFactory('BACKEND_BODY_TOO_LARGE', 'Backend request body is too large'),
  BACKEND_OUTPUT_TOO_LARGE: genericErrorFactory('BACKEND_OUTPUT_TOO_LARGE', 'Backend output is too large'),
  CSRF_REQUIRED: genericErrorFactory('CSRF_REQUIRED', 'Backend request requires CSRF protection'),
  UNAUTHORIZED: genericErrorFactory('UNAUTHORIZED', 'Backend request is unauthorized'),
};

const DAEMON_ERROR_HEADER = 'X-Mndw-Error';
const UNKNOWN_DAEMON_ERROR_CODE: BackendErrorCode = 'INTERNAL';
const UNKNOWN_DAEMON_ERROR_MESSAGE = 'Backend platform request failed';

const getDaemonCode = (value: string): BackendErrorCode | undefined => {
  return Object.prototype.hasOwnProperty.call(ERROR_BY_CODE, value) ? value as BackendErrorCode : undefined;
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

// The marker distinguishes daemon errors from plugin responses that may use the same JSON shape.
const mapResponse = async (id: string, res: Response): Promise<Response> => {
  if (res.ok || res.redirected !== false || !res.headers.has(DAEMON_ERROR_HEADER)) {
    return res;
  }

  let payload: unknown;

  try {
    payload = await res.clone().json();
  } catch {
    payload = undefined;
  }

  const rawError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const error: DaemonError = {
    code: typeof rawError?.code === 'string' ? rawError.code : undefined,
    message: typeof rawError?.message === 'string' ? rawError.message : undefined,
    detail: rawError?.detail,
  };
  const code = error.code ? getDaemonCode(error.code) : undefined;
  const options: BackendErrorOptions = {status: res.status, details: error.detail};

  if (!code) {
    throw new BackendError(
      error.message ?? UNKNOWN_DAEMON_ERROR_MESSAGE,
      UNKNOWN_DAEMON_ERROR_CODE,
      id,
      options,
    );
  }

  throw ERROR_BY_CODE[code](id, res, error, options);
};

const isAbortError = (error: unknown): boolean => {
  return isRecord(error) && error.name === 'AbortError';
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

  const fetchRoute = (id: string, options: BackendFetchOptions = {}): Promise<Response> => {
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
  };

  function call<T = unknown>(id: string, options: BackendCallOptions & {as: 'json'}): Promise<T>;
  function call(id: string, options: BackendCallOptions & {as: 'text'}): Promise<string>;
  function call(id: string, options: BackendCallOptions & {as: 'blob'}): Promise<Blob>;
  function call<T = unknown>(id: string, options?: BackendCallOptions): Promise<T | string | Blob>;
  function call<T = unknown>(id: string, options: BackendCallOptions = {}): Promise<T | string | Blob> {
    return fetchRoute(id, options).then(async (response) => {
      if (!response.ok) {
        const details = await response.text();

        throw new BackendError(
          `Backend route "${id}" returned HTTP ${response.status}`,
          'HTTP_ERROR',
          id,
          {status: response.status, details},
        );
      }

      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      const format = options.as
        ?? (mediaType === 'application/json' || mediaType.endsWith('+json')
          ? 'json'
          : mediaType.startsWith('text/')
          ? 'text'
          : 'blob');

      if (format === 'text') {
        return response.text();
      }

      if (format === 'blob') {
        return response.blob();
      }

      const body = await response.text();

      try {
        return JSON.parse(body) as T;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        throw new BackendError(
          `Backend route "${id}" returned invalid JSON`,
          'INVALID_RESPONSE',
          id,
          {status: response.status, details: body},
        );
      }
    });
  }

  return {
    fetch(id: string, options: BackendFetchOptions = {}): Promise<Response> {
      return fetchRoute(id, options);
    },

    call,

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
          return backendStatusSchema.parse(await response.json());
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
