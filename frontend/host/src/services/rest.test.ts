import {type Mock, describe, expect, it, vi} from 'vitest';
import {HostApiError, createRestClient} from './rest.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function restClient(fetchImpl: Mock<typeof globalThis.fetch>) {
  return createRestClient(
    fetchImpl,
    (message, code, detail, status) => new HostApiError(message, code, detail, status),
  );
}

describe('REST client CSRF', () => {
  it('does not send CSRF on a plain GET', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200, {}));

    await restClient(fetchImpl).request('/api/example', {method: 'GET'});

    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('X-Mndw-Csrf')).toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE'] as const)('sends CSRF on %s', async (method) => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200, {}));

    await restClient(fetchImpl).request('/api/example', {method});

    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('X-Mndw-Csrf')).toBe('1');
  });

  it('sends CSRF on a GET when explicitly opted in', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200, {}));

    await restClient(fetchImpl).request('/api/example', {method: 'GET', csrf: true});

    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('X-Mndw-Csrf')).toBe('1');
  });
});

describe('REST client requests', () => {
  it('serializes JSON and sets its content type', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200, {}));

    await restClient(fetchImpl).request('/api/example', {method: 'POST', json: {enabled: true}});

    const init = fetchImpl.mock.calls[0]?.[1];

    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"enabled":true}');
  });

  it('preserves a raw body content type and returns the raw response', async () => {
    const response = jsonResponse(201, {created: true});
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const body = new Blob(['archive']);

    await expect(
      restClient(fetchImpl).request('/api/upload', {
        method: 'POST',
        headers: {'Content-Type': 'application/zip'},
        body,
        response: 'raw',
      }),
    ).resolves.toBe(response);

    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe('application/zip');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(body);
  });

  it('maps error envelopes to the client error with status and detail', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(409, {
      error: {code: 'CONFLICT', message: 'already exists', detail: {resource: 'widget'}},
    }));

    await expect(restClient(fetchImpl).request('/api/example', {method: 'GET'})).rejects.toMatchObject({
      name: 'HostApiError',
      code: 'CONFLICT',
      detail: {resource: 'widget'},
      status: 409,
      message: 'already exists',
    });
  });

  it('maps malformed successful JSON to UNKNOWN', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('<html>', {status: 200}));

    await expect(restClient(fetchImpl).request('/api/example', {method: 'GET'})).rejects.toMatchObject({
      code: 'UNKNOWN',
      message: 'Malformed response',
    });
  });

  it('passes AbortSignal through to fetch', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200, {}));
    const signal = new AbortController().signal;

    await restClient(fetchImpl).request('/api/example', {method: 'GET', signal});

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(signal);
  });
});
