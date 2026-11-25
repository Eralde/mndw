import {readFileSync} from 'node:fs';
import type {BackendClient, BackendFetchOptions} from '@mndw/sdk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SmartClient} from './smart-client';

const fixture = (name: string): unknown => {
  return JSON.parse(readFileSync(`backend/testdata/wire/${name}.golden.json`, 'utf8'));
};

const response = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
};

describe('SmartClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses route IDs, query, acknowledgement, and decodes each response', async () => {
    const responses = [
      response(fixture('snapshot')),
      response({schemaVersion: 1, operationId: 'operation-1'}, 202),
      response({schemaVersion: 1, operationId: 'operation-2'}, 202),
      response((fixture('operation') as unknown[])[1]),
      response(fixture('device-type')),
    ];
    const fetch = vi.fn((_route: string, _options?: BackendFetchOptions): Promise<Response> => {
      const next = responses.shift();

      if (next === undefined) {
        throw new Error('unexpected backend request');
      }

      return Promise.resolve(next);
    });
    const backend = {fetch} as unknown as BackendClient;
    const client = new SmartClient(backend);

    await client.snapshot();
    await client.discover(true);
    await client.refresh('device-1', true);
    await client.operation('operation-1');
    await client.setDeviceType('device-1', 'sat');

    expect(fetch.mock.calls.map(([route]) => route)).toEqual([
      'snapshot',
      'discover',
      'refresh',
      'operation',
      'device-type',
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toEqual({acknowledgeWake: true});
    expect(fetch.mock.calls[2]?.[1]?.body).toEqual({deviceId: 'device-1', acknowledgeWake: true});
    expect(fetch.mock.calls[3]?.[1]?.query).toEqual({id: 'operation-1'});
    expect(fetch.mock.calls[4]?.[1]?.body).toEqual({deviceId: 'device-1', deviceType: 'sat'});
  });

  it('decodes plugin error envelopes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({schemaVersion: 1, error: {code: 'disconnected'}}, 409));
    const client = new SmartClient({fetch} as unknown as BackendClient);

    await expect(client.refresh('device-1', true)).rejects.toMatchObject({status: 409, code: 'disconnected'});
  });
});
