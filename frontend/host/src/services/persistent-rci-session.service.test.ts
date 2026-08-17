import {beforeEach, describe, expect, it, vi} from 'vitest';

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
  controller: {support: 'unknown'},
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

  it('probes controller token authentication through authenticated controller session', async () => {
    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify({probe: {found: true}}), {status: 200}));
    await expect(new PersistentRciSessionService().probeControllerTokenAuth()).resolves.toBe(true);
    expect(fetchWithDeadline).toHaveBeenCalledWith('/rci/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{"probe":"authentication token generate"}',
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
