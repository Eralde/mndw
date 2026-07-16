import {type Mock, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginListEntry} from '../runtime/plugin-types.js';
import {MgmtError, createMgmtClient, messageForError} from './mgmt-client.js';

const backend = {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false};

function entry(name: string, over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'user',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend,
    type: 'widget',
    size: {w: 4, h: 3},
    ...over,
  } as PluginListEntry;
}

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

describe('mgmt-client', () => {
  it('listPlugins GETs /api/mgmt/list and returns .plugins', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {plugins: [entry('a'), entry('b')]}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    const result = await client.listPlugins();

    expect(fetchImpl).toHaveBeenCalledWith('/api/mgmt/list', expect.objectContaining({method: 'GET'}));
    expect(result.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('uploadPlugin POSTs the raw zip body and discriminates 201 installed', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(201, entry('fresh')));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);
    const file = new File([new Uint8Array([1, 2, 3])], 'p.zip', {type: 'application/zip'});

    const result = await client.uploadPlugin(file);

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/api/mgmt/upload');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/zip');
    expect(init?.body).toBe(file);
    expect(result).toEqual({status: 'installed', entry: expect.objectContaining({name: 'fresh'})});
  });

  it('uploadPlugin discriminates 202 pending', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(
      202,
      entry('pend', {
        approval: 'pending',
        enabled: false,
      }),
    ));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);
    const file = new File([new Uint8Array([1])], 'p.zip');

    const result = await client.uploadPlugin(file);

    expect(result.status).toBe('pending');
  });

  it('approvePlugin POSTs {name} and returns the entry', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, entry('x')));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    const result = await client.approvePlugin('x');

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/api/mgmt/approve');
    expect(init?.method).toBe('POST');
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual({name: 'x'});
    expect(result.name).toBe('x');
  });

  it('denyPlugin and deletePlugin resolve void on {ok:true}', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {ok: true}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.denyPlugin('x')).resolves.toBeUndefined();
    await expect(client.deletePlugin('x')).resolves.toBeUndefined();
  });

  it('throws a typed MgmtError from the daemon envelope', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'MANIFEST_INVALID',
          message: 'bad',
          detail: 'name required',
        },
      }),
    );

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.uploadPlugin(new File([new Uint8Array([1])], 'p.zip'))).rejects.toMatchObject({
      code: 'MANIFEST_INVALID',
      detail: 'name required',
    });
  });

  it('falls back to a friendly message for an empty non-JSON error response', async () => {
    fetchImpl.mockResolvedValue(new Response('', {status: 500}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.listPlugins()).rejects.toSatisfy(
      (error: unknown) => messageForError(error) === 'Something went wrong.',
    );
  });

  it('messageForError maps known codes and includes MANIFEST_INVALID detail', () => {
    expect(messageForError(new MgmtError('x', 'UPLOAD_TOO_LARGE'))).toContain('10 MB');
    expect(messageForError(new MgmtError('x', 'MANIFEST_INVALID', 'route reserved'))).toContain('route reserved');
    expect(messageForError(new Error('boom'))).toBe('boom');
  });
});
