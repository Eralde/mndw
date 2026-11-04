import {type Mock, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PaletteTokenMap} from '@mndw/sdk';
import type {PluginPermission} from '@mndw/sdk-internal';
import type {PluginListEntry} from '../runtime/plugin-types.js';
import {
  MgmtError,
  type MgmtTimeoutKind,
  classifyMutationFailure,
  createMgmtClient,
  messageForError,
} from './mgmt-client.js';

const backend = {routes: {}};

function entry(name: string, over: Partial<PluginListEntry> = {}): PluginListEntry {
  return {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'upload',
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

const paletteFixture = {
  dark: {
    bg: '#030405',
    surface: '#0d0f10',
    surfaceRaised: '#151719',
    border: '#5d6266',
    textSubtle: '#b9c0c7',
    textMuted: '#d1d9e1',
    text: '#eaf3fb',
    accent: '#016ca5',
    accentHover: '#2b84bf',
    accentContrast: '#ffffff',
    danger: '#c5001b',
    dangerBg: '#ffd2cc',
    success: '#5cb572',
    warning: '#efa831',
  },
  light: {
    bg: '#f7fcfd',
    surface: '#edf2f3',
    surfaceRaised: '#f2f7f8',
    border: '#80878a',
    textSubtle: '#2f353a',
    textMuted: '#1d2328',
    text: '#0c1217',
    accent: '#016ca5',
    accentHover: '#005583',
    accentContrast: '#ffffff',
    danger: '#c5001b',
    dangerBg: '#ffe9e6',
    success: '#137738',
    warning: '#b37900',
  },
} as PaletteTokenMap;

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

  it('rejects malformed list responses instead of returning a cast payload', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {plugins: [{}]}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.listPlugins()).rejects.toThrow();
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

  it('rejects malformed upload entry responses', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(201, {notAnEntry: true}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.uploadPlugin(new File([new Uint8Array([1])], 'p.zip'))).rejects.toThrow();
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

  it('rejects malformed mutation entry responses', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {notAnEntry: true}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.approvePlugin('x')).rejects.toThrow();
  });

  it('setPluginPermission POSTs the permission mutation with CSRF and timeout', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(
      200,
      entry('x', {
        permissions: ['persistent-rci-session:write'],
        permissionGrants: {'persistent-rci-session:write': true},
      }),
    ));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);
    const permission: PluginPermission = 'persistent-rci-session:write';
    const result = await client.setPluginPermission('x', permission, true);
    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/api/mgmt/permission');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('X-Mndw-Csrf')).toBe('1');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'x',
      permission: 'persistent-rci-session:write',
      enabled: true,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result.permissionGrants?.['persistent-rci-session:write']).toBe(true);
  });

  it('rejects malformed permission mutation responses', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {notAnEntry: true}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.setPluginPermission('x', 'persistent-rci-session:write', true)).rejects.toThrow();
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

  it('getDeviceHardware GETs the protected endpoint and decodes hardware', async () => {
    const hardware = {
      list: [{
        id: 'WAN',
        label: '0',
        index: 0,
        type: 'ethernet',
        group: 'WAN',
        color: 'blue',
        interfaceId: 'GigabitEthernet1/0',
      }],
      layout: [['0']],
      hasPortStats: false,
    };

    fetchImpl.mockResolvedValue(jsonResponse(200, {switchports: hardware, usbPortCount: 1}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.getDeviceHardware()).resolves.toEqual({switchports: hardware, usbPortCount: 1});
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/mgmt/device-hardware',
      expect.objectContaining({method: 'GET', signal: expect.any(AbortSignal)}),
    );
  });

  it.each([
    ['non-2xx', jsonResponse(502, {error: {code: 'BAD_GATEWAY'}})],
    ['malformed 200', jsonResponse(200, {switchports: {}})],
    ['timeout', new DOMException('timed out', 'TimeoutError')],
  ])('getDeviceHardware returns fresh empty hardware on %s', async (_name, failure) => {
    if (failure instanceof Response) {
      fetchImpl.mockResolvedValue(failure);
    } else {
      fetchImpl.mockRejectedValue(failure);
    }

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    const first = await client.getDeviceHardware();
    const second = await client.getDeviceHardware();

    expect(first).toEqual({
      switchports: {list: [], layout: [], hasPortStats: false},
      usbPortCount: 0,
    });
    expect(second.switchports.list).not.toBe(first.switchports.list);
    expect(second.switchports.layout).not.toBe(first.switchports.layout);
  });

  it('messageForError maps known codes and includes MANIFEST_INVALID detail', () => {
    expect(messageForError(new MgmtError('x', 'UPLOAD_TOO_LARGE'))).toContain('10 MB');
    expect(messageForError(new MgmtError('x', 'MANIFEST_INVALID', 'route reserved'))).toContain('route reserved');
    expect(messageForError(new MgmtError('x', 'CONTROLLER_SESSION_UNAVAILABLE'))).toContain('Controller token session');
    expect(messageForError(new MgmtError('x', 'RCI_SOCKET_START_FAILED'))).toContain('session socket');
    expect(messageForError(new Error('boom'))).toBe('boom');
  });

  it('coerces non-string envelope fields instead of trusting the JSON cast', async () => {
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({error: {code: 42, message: 42, detail: 42}}), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: {'content-type': 'application/json'},
      }),
    );

    const error = await createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch)
      .listPlugins()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MgmtError);
    expect((error as MgmtError).code).toBe('UNKNOWN');
    expect((error as MgmtError).message).toBe('Internal Server Error');
  });

  it('classifies maintenance rejection using the decoded string code', async () => {
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({error: {code: 'BACKEND_MAINTENANCE', message: 'updating'}}), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {'content-type': 'application/json'},
      }),
    );

    const error = await createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch)
      .listPlugins()
      .catch((cause: unknown) => cause);

    expect(classifyMutationFailure(error)).toBe('rejected-maintenance');
  });

  it('does not classify a non-string maintenance code as maintenance rejection', () => {
    expect(classifyMutationFailure(new MgmtError('x', 'UNKNOWN', 42))).toBe('error');
  });

  it('omits a non-string MANIFEST_INVALID detail instead of interpolating it', () => {
    expect(messageForError(new MgmtError('x', 'MANIFEST_INVALID', {a: 1}))).not.toContain('[object Object]');
  });
});

describe('mgmt-client palette', () => {
  it('getPalette GETs the palette endpoint and unwraps palette', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {palette: paletteFixture}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    expect(await client.getPalette()).toEqual(paletteFixture);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/mgmt/palette',
      expect.objectContaining({method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal)}),
    );
  });

  it('getPalette returns null when no override exists', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {palette: null}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.getPalette()).resolves.toBeNull();
  });

  it.each([null, 42, 'palette', [], {}, {other: paletteFixture}])(
    'rejects malformed GET response %p with MgmtError',
    async (body) => {
      fetchImpl.mockResolvedValue(jsonResponse(200, body));

      const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

      await expect(client.getPalette()).rejects.toBeInstanceOf(MgmtError);
    },
  );

  it('rejects a non-JSON successful GET with MgmtError', async () => {
    fetchImpl.mockResolvedValue(new Response('<!doctype html>', {status: 200}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.getPalette()).rejects.toBeInstanceOf(MgmtError);
  });

  it('putPalette sends bare JSON and accepts only 204', async () => {
    fetchImpl.mockResolvedValue(new Response(null, {status: 204}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await client.putPalette(paletteFixture);

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/api/mgmt/palette');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual(paletteFixture);
  });

  it.each([200, 201, 202])('rejects PUT status %d as a protocol error', async (status) => {
    fetchImpl.mockResolvedValue(new Response(null, {status}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.putPalette(paletteFixture)).rejects.toMatchObject({code: 'UNKNOWN'});
  });

  it('deletePalette accepts only 204', async () => {
    fetchImpl.mockResolvedValue(new Response(null, {status: 204}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await client.deletePalette();
  });

  it.each([200, 201, 202])('rejects DELETE status %d as a protocol error', async (status) => {
    fetchImpl.mockResolvedValue(new Response(null, {status}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await expect(client.deletePalette()).rejects.toMatchObject({code: 'UNKNOWN'});
  });
});

describe('mgmt-client timeouts', () => {
  it.each(
    [
      [
        'listPlugins',
        (client: ReturnType<typeof createMgmtClient>) => client.listPlugins(),
        {plugins: [entry('p')]},
        'read',
      ],
      [
        'deletePlugin',
        (client: ReturnType<typeof createMgmtClient>) => client.deletePlugin('p'),
        {ok: true},
        'mutation',
      ],
      [
        'enablePlugin',
        (client: ReturnType<typeof createMgmtClient>) => client.enablePlugin('p'),
        entry('p'),
        'mutation',
      ],
      [
        'restartPlugin',
        (client: ReturnType<typeof createMgmtClient>) => client.restartPlugin('p'),
        {ok: true},
        'mutation',
      ],
      [
        'approvePlugin',
        (client: ReturnType<typeof createMgmtClient>) => client.approvePlugin('p'),
        entry('p'),
        'install',
      ],
    ] as const,
  )('selects the %s timeout tier', async (_method, invoke, response, expectedKind) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, response));

    const kinds: MgmtTimeoutKind[] = [];
    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch, (kind) => {
      kinds.push(kind);

      return new AbortController().signal;
    });

    await invoke(client);

    expect(kinds).toEqual([expectedKind]);
  });

  it('leaves upload unbounded without a timeout signal', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(201, entry('fresh')));

    const makeSignal = vi.fn<(kind: MgmtTimeoutKind) => AbortSignal>();
    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch, makeSignal);

    await client.uploadPlugin(new File([new Uint8Array([1])], 'p.zip'));

    expect(makeSignal).not.toHaveBeenCalled();
  });

  it('passes an abort signal on regular requests but not upload', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {palette: null}));

    const client = createMgmtClient(fetchImpl as unknown as typeof globalThis.fetch);

    await client.getPalette();

    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    fetchImpl.mockReset().mockResolvedValue(jsonResponse(201, entry('fresh')));
    await client.uploadPlugin(new File([new Uint8Array([1])], 'p.zip'));

    expect(fetchImpl.mock.calls[0][1]?.signal).toBeUndefined();
  });

  it('maps TimeoutError to device response copy', () => {
    expect(messageForError(new DOMException('signal timed out', 'TimeoutError'))).toBe(
      'The device did not respond.',
    );
  });

  it('classifies transport ambiguity, maintenance rejection, and hard errors', () => {
    expect(classifyMutationFailure(new DOMException('timed out', 'TimeoutError'))).toBe('ambiguous');
    expect(classifyMutationFailure(new TypeError('network error'))).toBe('ambiguous');
    expect(classifyMutationFailure(new MgmtError('busy', 'BACKEND_MAINTENANCE'))).toBe('rejected-maintenance');
    expect(classifyMutationFailure(new MgmtError('nope', 'CONFLICT'))).toBe('error');
  });
});
