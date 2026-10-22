import {beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';

const {fetchWithDeadline} = vi.hoisted(() => ({
  fetchWithDeadline: vi.fn<(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number) => Promise<Response>>(),
}));

vi.mock('./pristine-fetch.js', () => ({fetchWithDeadline}));

import {
  PersistentRciSessionError,
  PersistentRciSessionService,
  createPersistentRciSessionService,
} from './persistent-rci-session.service.js';

const capability = {
  store: {state: 'empty'},
  controller: {support: 'unknown', auth: 'unknown', enabled: false},
  extenders: [
    {identity: 'bad', name: 'Bad', eligible: false, reason: 'missing-fqdn'},
    {identity: 'pending', name: 'Pending', eligible: true, state: 'establishing'},
    {identity: 'live', name: 'Live', eligible: true, state: 'live', lastError: 'transient'},
  ],
  stale: false,
};

describe('PersistentRciSessionService', () => {
  beforeEach(() => fetchWithDeadline.mockReset());

  it('creates independent service instances', () => {
    expect(createPersistentRciSessionService()).not.toBe(createPersistentRciSessionService());
  });

  it('loads and validates capability state with omission rules', async () => {
    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify(capability), {status: 200}));
    await expect(new PersistentRciSessionService().getCapability()).resolves.toEqual(capability);
  });

  it('parses every generated capability fixture', async () => {
    const directory = resolve(process.cwd(), 'src/services/fixtures/rci-session/capability');
    const service = new PersistentRciSessionService();

    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      const fixture = JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as unknown;

      fetchWithDeadline.mockResolvedValueOnce(new Response(JSON.stringify(fixture), {status: 200}));
      await expect(service.getCapability()).resolves.toEqual(fixture);
    }
  });

  it('parses tokenless controller capability', async () => {
    const tokenless = {
      ...capability,
      controller: {support: 'supported', auth: 'none', enabled: true},
    };

    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify(tokenless), {status: 200}));

    await expect(new PersistentRciSessionService().getCapability()).resolves.toEqual(tokenless);
  });

  it('rejects capability with unknown auth mode', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({...capability, controller: {support: 'supported', auth: 'basic', enabled: true}}), {
        status: 200,
      }),
    );

    await expect(new PersistentRciSessionService().getCapability()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('rejects capability without enabled boolean', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({...capability, controller: {support: 'supported', auth: 'none'}}), {status: 200}),
    );

    await expect(new PersistentRciSessionService().getCapability()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('accepts needs-token support', async () => {
    const needsToken = {
      ...capability,
      controller: {support: 'needs-token', auth: 'token', enabled: true},
    };

    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify(needsToken), {status: 200}));

    await expect(new PersistentRciSessionService().getCapability()).resolves.toEqual(needsToken);
  });

  it('rejects ineligible entries carrying session fields', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...capability,
          extenders: [{identity: 'bad', name: 'Bad', eligible: false, reason: 'missing-fqdn', state: 'offline'}],
        }),
        {status: 200},
      ),
    );
    await expect(new PersistentRciSessionService().getCapability()).rejects.toMatchObject({code: 'MALFORMED_RESPONSE'});
  });

  it('setEnabled sends PUT with csrf header and body', async () => {
    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify({result: 'enabled'}), {status: 200}));

    await new PersistentRciSessionService().setEnabled(true);

    expect(fetchWithDeadline).toHaveBeenCalledWith('/api/mndw/rci-session/enabled', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-Mndw-Csrf': '1'},
      body: '{"enabled":true}',
    });
  });

  it('setEnabled maps RCI_AUTH_MODE_MISMATCH', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({error: {code: 'RCI_AUTH_MODE_MISMATCH'}}), {status: 409}),
    );

    await expect(new PersistentRciSessionService().setEnabled(true)).rejects.toMatchObject({
      code: 'RCI_AUTH_MODE_MISMATCH',
      status: 409,
    });
  });

  it('posts controller token without putting it in URL', async () => {
    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify({result: 'valid'}), {status: 200}));
    await expect(new PersistentRciSessionService().testController('secret-token')).resolves.toEqual({result: 'valid'});
    expect(fetchWithDeadline).toHaveBeenCalledWith(
      '/api/mndw/rci-session/controller/test',
      expect.objectContaining({
        method: 'POST',
        body: '{"token":"secret-token"}',
      }),
    );
  });

  it('maps daemon errors without secret detail', async () => {
    fetchWithDeadline.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({error: {code: 'RCI_TOKEN_INVALID'}}), {status: 422}))
    );

    const service = new PersistentRciSessionService();

    await expect(service.saveController('secret-token')).rejects.toMatchObject({code: 'RCI_TOKEN_INVALID',
      status: 422});

    try {
      await service.saveController('secret-token');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistentRciSessionError);
      expect((error as Error).message).not.toContain('secret-token');
    }
  });
});
