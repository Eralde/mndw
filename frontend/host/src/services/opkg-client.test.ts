import {type Mock, beforeEach, describe, expect, it, vi} from 'vitest';
import {OpkgError, createOpkgClient} from './opkg-client.js';

const packageEntry = {
  name: 'jq',
  version: '1.6-2',
  description: 'JSON processor',
  status: 'update_available' as const,
  newVersion: '1.7-1',
};

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

describe('opkg-client', () => {
  it('lists packages with a GET request', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {packages: [packageEntry]}));

    const result = await createOpkgClient(fetchImpl).list();

    expect(fetchImpl).toHaveBeenCalledWith('/api/mgmt/opkg/list', {method: 'GET'});
    expect(result).toEqual([packageEntry]);
  });

  it.each(
    [
      ['install', 'install', ['curl', 'ttyd']],
      ['remove', 'remove', ['curl']],
      ['upgrade', 'upgrade', ['jq']],
    ] as const,
  )('%s sends packages and returns action response', async (operation, path, packages) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {ok: true, message: 'done', packages}));

    const client = createOpkgClient(fetchImpl);

    const result = await client[operation]([...packages]);

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe(`/api/mgmt/opkg/${path}`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({packages});
    expect(result).toEqual({message: 'done', packages});
  });

  it('updates package metadata with an empty JSON body', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {ok: true, message: 'Package metadata refreshed'}));

    const result = await createOpkgClient(fetchImpl).update();

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/api/mgmt/opkg/update');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({});
    expect(result).toEqual({message: 'Package metadata refreshed'});
  });

  it('maps daemon error envelopes to OpkgError', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(502, {error: {code: 'OPKG_FAILED', message: 'failed'}}));

    await expect(createOpkgClient(fetchImpl).list()).rejects.toMatchObject({
      name: 'OpkgError',
      code: 'OPKG_FAILED',
      message: 'failed',
    });
  });

  it('falls back for malformed non-2xx error bodies', async () => {
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({unexpected: true}), {status: 400, statusText: 'Bad Request'}),
    );

    await expect(createOpkgClient(fetchImpl).list()).rejects.toEqual(
      expect.objectContaining({code: 'UNKNOWN', message: 'Bad Request'}),
    );
  });
});

describe('opkg-client validation', () => {
  it.each([
    null,
    '<html>',
    {packages: 'wrong'},
    {packages: [{...packageEntry, name: ''}]},
    {packages: [{...packageEntry, status: 'bogus'}]},
    {packages: [{...packageEntry, status: 'update_available', newVersion: ''}]},
  ])('rejects malformed success response %j', async (body) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, body));

    await expect(createOpkgClient(fetchImpl).list()).rejects.toBeInstanceOf(OpkgError);
  });

  it('rejects action responses with non-string package names', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {ok: true, message: 'done', packages: [1]}));

    await expect(createOpkgClient(fetchImpl).install(['curl'])).rejects.toMatchObject({
      name: 'OpkgError',
      code: 'UNKNOWN',
      message: 'Malformed response',
    });
  });

  it('rejects action responses with ok false', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {ok: false, message: 'failed', packages: []}));

    await expect(createOpkgClient(fetchImpl).install(['curl'])).rejects.toMatchObject({
      name: 'OpkgError',
      message: 'Malformed response',
    });
  });

  it('returns a non-null empty list', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {packages: []}));

    const result = await createOpkgClient(fetchImpl).list();

    expect(result).toEqual([]);
  });
});
