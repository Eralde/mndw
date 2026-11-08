import {CSRF_HEADERS} from './csrf.js';
import {decodeErrorEnvelope, readErrorBody} from './error-envelope.js';

export class HostApiError extends Error {
  public readonly code: string;
  public readonly detail: unknown;
  public readonly status: number | undefined;

  constructor(message: string, code: string, detail?: unknown, status?: number) {
    super(message);
    this.name = 'HostApiError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export type HostApiErrorFactory<E extends HostApiError> = (
  message: string,
  code: string,
  detail?: unknown,
  status?: number,
) => E;

export interface RestRequestInit extends RequestInit {
  csrf?: boolean;
  json?: unknown;
  response?: 'json' | 'raw';
}

export interface RestRequest {
  (input: RequestInfo | URL, init: RestRequestInit & {response: 'raw'}): Promise<Response>;
  <T = unknown>(input: RequestInfo | URL, init?: RestRequestInit & {response?: 'json'}): Promise<T>;
}

export interface RestClient<E extends HostApiError> {
  request: RestRequest;
  parseJson(response: Response): Promise<unknown>;
  malformed(): E;
  errorFromResponse(response: Response): Promise<E>;
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });

    return result;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }

    return result;
  }

  if (headers !== undefined) {
    Object.assign(result, headers);
  }

  return result;
}

function setHeader(headers: Record<string, string>, key: string, value: string): void {
  const existingKey = Object.keys(headers).find((header) => header.toLowerCase() === key.toLowerCase());

  headers[existingKey ?? key] = value;
}

export function malformedApiResponse<E extends HostApiError>(makeError: HostApiErrorFactory<E>): E {
  return makeError('Malformed response', 'UNKNOWN');
}

export function createRestClient<E extends HostApiError>(
  fetchImpl: typeof globalThis.fetch,
  makeError: HostApiErrorFactory<E>,
): RestClient<E> {
  const malformed = (): E => malformedApiResponse(makeError);

  async function parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw malformed();
    }
  }

  async function errorFromResponse(response: Response): Promise<E> {
    const fields = decodeErrorEnvelope(await readErrorBody(response), response.statusText);

    return makeError(fields.message, fields.code, fields.detail, response.status);
  }

  const request = (async (
    input: RequestInfo | URL,
    options: RestRequestInit = {},
  ): Promise<unknown | Response> => {
    const {csrf, json, response: responseType, ...init} = options;
    const method = init.method?.toUpperCase() ?? 'GET';
    const shouldSendCsrf = (method !== 'GET' && method !== 'HEAD') || csrf === true;
    const hasJson = Object.prototype.hasOwnProperty.call(options, 'json');
    const requestInit: RequestInit = {...init};

    if (hasJson) {
      requestInit.body = JSON.stringify(json);
    }

    if (shouldSendCsrf || hasJson) {
      const headers = headersRecord(init.headers);

      if (hasJson) {
        setHeader(headers, 'Content-Type', 'application/json');
      }

      if (shouldSendCsrf) {
        for (const [key, value] of Object.entries(CSRF_HEADERS)) {
          setHeader(headers, key, value);
        }
      }

      requestInit.headers = headers;
    }

    const result = await fetchImpl(input, requestInit);

    if (!result.ok) {
      throw await errorFromResponse(result);
    }

    if (responseType === 'raw') {
      return result;
    }

    return await parseJson(result);
  }) as RestRequest;

  return {request, parseJson, malformed, errorFromResponse};
}
