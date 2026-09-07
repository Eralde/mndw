import {type Mock, beforeEach, describe, expect, it, vi} from 'vitest';
import {SelfUpdateError, createSelfUpdateClient} from './self-update-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

let fetchImpl: Mock<typeof globalThis.fetch>;

beforeEach(() => {
  fetchImpl = vi.fn<typeof globalThis.fetch>();
});

describe('self-update-client', () => {
  it('reads status with a GET request', async () => {
    const status = {state: 'idle', version: '0.0.4', rollbackVersion: '0.0.3'};

    fetchImpl.mockResolvedValue(jsonResponse(200, status));

    await expect(createSelfUpdateClient(fetchImpl).status()).resolves.toEqual(status);
    expect(fetchImpl).toHaveBeenCalledWith('/api/mgmt/self-update/status', {method: 'GET'});
  });

  it('posts an empty object with CSRF headers for each action', async () => {
    const responses = [
      {currentVersion: '0.0.4', targetVersion: '0.0.5', updateAvailable: true, rollbackAvailable: false},
      {operation: 'update', targetVersion: '0.0.5'},
      {operation: 'revert', targetVersion: '0.0.3'},
    ];

    fetchImpl
      .mockResolvedValueOnce(jsonResponse(200, responses[0]))
      .mockResolvedValueOnce(jsonResponse(202, responses[1]))
      .mockResolvedValueOnce(jsonResponse(202, responses[2]));

    const client = createSelfUpdateClient(fetchImpl);

    await client.check();
    await client.apply();
    await client.revert();

    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toMatch(/^\/api\/mgmt\/self-update\/(check|apply|revert)$/);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(new Headers(init?.headers).get('X-Mndw-Csrf')).toBe('1');
      expect(init?.body).toBe('{}');
    }
  });

  it('returns server-derived target from apply', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(202, {operation: 'update', targetVersion: '0.0.6'}));

    await expect(createSelfUpdateClient(fetchImpl).apply()).resolves.toEqual({
      operation: 'update',
      targetVersion: '0.0.6',
    });
  });

  it('maps daemon error envelopes to SelfUpdateError', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(409, {error: {code: 'OPKG_BUSY', message: 'busy'}}));

    await expect(createSelfUpdateClient(fetchImpl).apply()).rejects.toEqual(
      expect.objectContaining({name: 'SelfUpdateError', code: 'OPKG_BUSY', message: 'busy'}),
    );
  });

  it('falls back for non-JSON error bodies', async () => {
    fetchImpl.mockResolvedValue(new Response('<html>', {status: 502, statusText: 'Bad Gateway'}));

    await expect(createSelfUpdateClient(fetchImpl).status()).rejects.toEqual(
      expect.objectContaining({name: 'SelfUpdateError', code: 'UNKNOWN', message: 'Bad Gateway'}),
    );
  });

  it.each([
    null,
    [],
    {state: 'unknown', version: '0.0.4'},
    {state: 'idle'},
    {state: 'idle', version: '0.0.4', operation: 'bad'},
    {state: 'idle', version: '0.0.4', rollbackVersion: 3},
  ])('rejects malformed status response %j', async (body) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, body));

    await expect(createSelfUpdateClient(fetchImpl).status()).rejects.toMatchObject({
      name: 'SelfUpdateError',
      code: 'UNKNOWN',
      message: 'Malformed response',
    });
  });

  it.each([
    {currentVersion: '0.0.4', targetVersion: '0.0.5', updateAvailable: 'yes', rollbackAvailable: false},
    {currentVersion: '0.0.4', updateAvailable: true, rollbackAvailable: false},
    {currentVersion: '0.0.4', targetVersion: '', updateAvailable: true, rollbackAvailable: false},
  ])('rejects malformed check response %j', async (body) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, body));

    await expect(createSelfUpdateClient(fetchImpl).check()).rejects.toBeInstanceOf(SelfUpdateError);
  });

  it.each([
    null,
    {operation: 'update'},
    {operation: 'bad', targetVersion: '0.0.5'},
    {operation: 'update', targetVersion: ''},
  ])('rejects malformed accepted response %j', async (body) => {
    fetchImpl.mockResolvedValue(jsonResponse(202, body));

    await expect(createSelfUpdateClient(fetchImpl).apply()).rejects.toBeInstanceOf(SelfUpdateError);
  });
});
