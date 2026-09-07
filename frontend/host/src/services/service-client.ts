import {
  SERVICE_LIST_URL,
  SERVICE_RESTART_URL,
  SERVICE_SET_ENABLED_URL,
  SERVICE_START_URL,
  SERVICE_STATUS_URL,
  SERVICE_STOP_URL,
} from '../constants.js';
import {decodeErrorEnvelope, readErrorBody} from './error-envelope.js';
import {isRecord} from './json.js';

export type ServiceState = 'running' | 'stopped' | 'unknown';

export interface ServiceEntry {
  name: string;
  label: string;
  state: ServiceState;
  enabledAtBoot: boolean;
  pid?: number;
  autostartPinned: boolean;
  protected: boolean;
}

export interface ServiceActionResponse {
  ok: true;
  service: ServiceEntry;
}

export class ServiceError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

const malformedResponse = (): ServiceError => new ServiceError('Malformed response', 'UNKNOWN');

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw malformedResponse();
  }
}

async function errorFromResponse(response: Response): Promise<ServiceError> {
  const fields = decodeErrorEnvelope(await readErrorBody(response), response.statusText);

  return new ServiceError(fields.message, fields.code);
}

function validateService(value: unknown): ServiceEntry {
  if (!isRecord(value)) {
    throw malformedResponse();
  }

  if (
    typeof value.name !== 'string' || typeof value.label !== 'string'
    || (value.state !== 'running' && value.state !== 'stopped' && value.state !== 'unknown')
    || typeof value.enabledAtBoot !== 'boolean'
    || (value.pid !== undefined && typeof value.pid !== 'number')
    || typeof value.autostartPinned !== 'boolean'
    || typeof value.protected !== 'boolean'
  ) {
    throw malformedResponse();
  }

  return {
    name: value.name,
    label: value.label,
    state: value.state,
    enabledAtBoot: value.enabledAtBoot,
    ...(value.pid === undefined ? {} : {pid: value.pid}),
    autostartPinned: value.autostartPinned,
    protected: value.protected,
  };
}

function validateList(value: unknown): ServiceEntry[] {
  if (!isRecord(value) || !Array.isArray(value.services)) {
    throw malformedResponse();
  }

  return value.services.map((service) => validateService(service));
}

function validateAction(value: unknown): ServiceActionResponse {
  if (!isRecord(value) || value.ok !== true || value.service === undefined) {
    throw malformedResponse();
  }

  return {ok: true, service: validateService(value.service)};
}

export interface ServiceClient {
  list(): Promise<ServiceEntry[]>;
  status(name: string, signal?: AbortSignal): Promise<ServiceEntry>;
  start(name: string): Promise<ServiceActionResponse>;
  stop(name: string): Promise<ServiceActionResponse>;
  restart(name: string): Promise<ServiceActionResponse>;
  setEnabled(name: string, enabled: boolean): Promise<ServiceActionResponse>;
}

export function createServiceClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): ServiceClient {
  async function request(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, init);

    if (!response.ok) {
      throw await errorFromResponse(response);
    }

    return parseJson(response);
  }

  async function action(url: string, name: string): Promise<ServiceActionResponse> {
    const body = await request(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });

    return validateAction(body);
  }

  return {
    async list(): Promise<ServiceEntry[]> {
      return validateList(await request(SERVICE_LIST_URL, {method: 'GET'}));
    },

    async status(name: string, signal?: AbortSignal): Promise<ServiceEntry> {
      const params = new URLSearchParams({name});
      const body = await request(`${SERVICE_STATUS_URL}?${params.toString()}`, {method: 'GET', signal});

      if (!isRecord(body) || body.service === undefined) {
        throw malformedResponse();
      }

      return validateService(body.service);
    },

    start: (name) => action(SERVICE_START_URL, name),
    stop: (name) => action(SERVICE_STOP_URL, name),
    restart: (name) => action(SERVICE_RESTART_URL, name),
    async setEnabled(name: string, enabled: boolean): Promise<ServiceActionResponse> {
      const body = await request(SERVICE_SET_ENABLED_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, enabled}),
      });

      return validateAction(body);
    },
  };
}

export const serviceClient: ServiceClient = createServiceClient();
