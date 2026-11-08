import {
  SERVICE_LIST_URL,
  SERVICE_RESTART_URL,
  SERVICE_SET_ENABLED_URL,
  SERVICE_START_URL,
  SERVICE_STATUS_URL,
  SERVICE_STOP_URL,
} from '../constants.js';
import {isRecord} from './json.js';
import {HostApiError, createRestClient, malformedApiResponse} from './rest.js';

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

export class ServiceError extends HostApiError {
  constructor(message: string, code: string, status?: number, detail?: unknown) {
    super(message, code, detail, status);
    this.name = 'ServiceError';
  }
}

const makeServiceError = (message: string, code: string, detail?: unknown, status?: number): ServiceError => {
  return new ServiceError(message, code, status, detail);
};

function validateService(value: unknown): ServiceEntry {
  if (!isRecord(value)) {
    throw malformedApiResponse(makeServiceError);
  }

  if (
    typeof value.name !== 'string' || typeof value.label !== 'string'
    || (value.state !== 'running' && value.state !== 'stopped' && value.state !== 'unknown')
    || typeof value.enabledAtBoot !== 'boolean'
    || (value.pid !== undefined && typeof value.pid !== 'number')
    || typeof value.autostartPinned !== 'boolean'
    || typeof value.protected !== 'boolean'
  ) {
    throw malformedApiResponse(makeServiceError);
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
    throw malformedApiResponse(makeServiceError);
  }

  return value.services.map((service) => validateService(service));
}

function validateAction(value: unknown): ServiceActionResponse {
  if (!isRecord(value) || value.ok !== true || value.service === undefined) {
    throw malformedApiResponse(makeServiceError);
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
  const rest = createRestClient(fetchImpl, makeServiceError);

  async function action(url: string, name: string): Promise<ServiceActionResponse> {
    const body = await rest.request(url, {
      method: 'POST',
      json: {name},
    });

    return validateAction(body);
  }

  return {
    async list(): Promise<ServiceEntry[]> {
      return validateList(await rest.request(SERVICE_LIST_URL, {method: 'GET'}));
    },

    async status(name: string, signal?: AbortSignal): Promise<ServiceEntry> {
      const params = new URLSearchParams({name});
      const body = await rest.request(`${SERVICE_STATUS_URL}?${params.toString()}`, {method: 'GET', signal});

      if (!isRecord(body) || body.service === undefined) {
        throw malformedApiResponse(makeServiceError);
      }

      return validateService(body.service);
    },

    start: (name) => action(SERVICE_START_URL, name),
    stop: (name) => action(SERVICE_STOP_URL, name),
    restart: (name) => action(SERVICE_RESTART_URL, name),
    async setEnabled(name: string, enabled: boolean): Promise<ServiceActionResponse> {
      const body = await rest.request(SERVICE_SET_ENABLED_URL, {
        method: 'POST',
        json: {name, enabled},
      });

      return validateAction(body);
    },
  };
}

export const serviceClient: ServiceClient = createServiceClient();
