import {type Mock, beforeEach, describe, expect, it, vi} from 'vitest';
import {type ServiceEntry, createServiceClient} from './service-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

const entry: ServiceEntry = {
  name: 'S99foo',
  label: 'foo',
  state: 'unknown',
  enabledAtBoot: true,
  autostartPinned: false,
  protected: false,
};

const cmdlineResolvedEntry: ServiceEntry = {
  ...entry,
  name: 'S77ntpd',
  label: 'ntpd',
  state: 'running',
  pid: 1516,
};

let fetchImpl: Mock<typeof globalThis.fetch>;

beforeEach(() => {
  fetchImpl = vi.fn<typeof globalThis.fetch>();
});

describe('service-client', () => {
  it('lists and validates service entries', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {services: [entry]}));

    await expect(createServiceClient(fetchImpl).list()).resolves.toEqual([entry]);
    expect(fetchImpl).toHaveBeenCalledWith('/api/mgmt/service/list', {method: 'GET'});
  });

  it('encodes status names and forwards AbortSignal', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {service: {...entry, name: 'S99foo bar'}}));

    const signal = new AbortController().signal;

    await createServiceClient(fetchImpl).status('S99foo bar', signal);

    expect(fetchImpl).toHaveBeenCalledWith('/api/mgmt/service/status?name=S99foo+bar', {method: 'GET', signal});
  });

  it('parses a PID when status provides one', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {service: {...entry, pid: 4321}}));

    await expect(createServiceClient(fetchImpl).status('S99foo')).resolves.toMatchObject({pid: 4321});
  });

  it('accepts a PID produced by cmdline resolution', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {service: cmdlineResolvedEntry}));

    await expect(createServiceClient(fetchImpl).status('S77ntpd')).resolves.toEqual(cmdlineResolvedEntry);
  });

  it('rejects a nonnumeric PID', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {service: {...entry, pid: '4321'}}));

    await expect(createServiceClient(fetchImpl).status('S99foo')).rejects.toMatchObject({code: 'UNKNOWN'});
  });

  it('parses pinned autostart state', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {services: [{...entry, autostartPinned: true}]}));

    await expect(createServiceClient(fetchImpl).list()).resolves.toEqual([{...entry, autostartPinned: true}]);
  });
});

describe('service-client actions', () => {
  it.each(['start', 'stop', 'restart'] as const)('posts %s action', async (action) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, {ok: true, service: entry}));

    await expect(createServiceClient(fetchImpl)[action]('S99foo')).resolves.toEqual({ok: true, service: entry});

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe(`/api/mgmt/service/${action}`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({name: 'S99foo'});
  });

  it('posts the requested autostart state', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse(200, {ok: true, service: {...entry, name: 'K99foo', enabledAtBoot: false}}),
    );

    await expect(createServiceClient(fetchImpl).setEnabled('S99foo', false)).resolves.toMatchObject({
      service: {name: 'K99foo', enabledAtBoot: false},
    });

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/api/mgmt/service/set-enabled');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({name: 'S99foo', enabled: false});
  });

  it('preserves conflict errors from set-enabled', async () => {
    fetchImpl.mockResolvedValue(jsonResponse(409, {error: {code: 'CONFLICT', message: 'autostart is pinned'}}));

    await expect(createServiceClient(fetchImpl).setEnabled('S99foo', false)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'autostart is pinned',
    });
  });

  it.each([[], {services: [{...entry, state: 'bad'}]}])('rejects malformed responses %j', async (body) => {
    fetchImpl.mockResolvedValue(jsonResponse(200, body));

    await expect(createServiceClient(fetchImpl).list()).rejects.toMatchObject({code: 'UNKNOWN'});
  });
});
