import {beforeEach, describe, expect, it, vi} from 'vitest';

const {fetchWithDeadline} = vi.hoisted(() => ({
  fetchWithDeadline: vi.fn<(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number) => Promise<Response>>(),
}));

vi.mock('./pristine-fetch.js', () => ({fetchWithDeadline}));

import {PersistentRciSessionError, PersistentRciSessionService} from './persistent-rci-session.service.js';

describe('PersistentRciSessionService', () => {
  beforeEach(() => fetchWithDeadline.mockReset());

  it('loads capability with CSRF header', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({store: {state: 'empty'}, controller: {support: 'unknown'}, extenders: []}), {
        status: 200,
      }),
    );

    const service = new PersistentRciSessionService();

    await expect(service.getCapability()).resolves.toEqual({store: {state: 'empty'}, controller: {support: 'unknown'},
      extenders: []});
    expect(fetchWithDeadline).toHaveBeenCalledWith('/api/mndw/rci-session/capability', {headers: {'X-Mndw-Csrf': '1'}});
  });

  it('probes controller token authentication through the authenticated controller session', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({probe: {found: true, permitted: true}}), {status: 200}),
    );

    const service = new PersistentRciSessionService();

    await expect(service.probeControllerTokenAuth()).resolves.toBe(true);
    expect(fetchWithDeadline).toHaveBeenCalledWith('/rci/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{"probe":"authentication token generate"}',
    });
  });

  it('does not expose controller token authentication when probe is not found', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({probe: {found: false}}), {status: 200}),
    );

    const service = new PersistentRciSessionService();

    await expect(service.probeControllerTokenAuth()).resolves.toBe(false);
  });

  it('posts controller token without putting it in URL', async () => {
    fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify({result: 'valid'}), {status: 200}));

    const service = new PersistentRciSessionService();

    await expect(service.testController('secret-token')).resolves.toEqual({result: 'valid'});
    expect(fetchWithDeadline).toHaveBeenCalledWith(
      '/api/mndw/rci-session/controller/test',
      expect.objectContaining({
        method: 'POST',
        body: '{"token":"secret-token"}',
      }),
    );
  });

  it('maps daemon error envelope to stable error without secret detail', async () => {
    fetchWithDeadline.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({error: {code: 'RCI_TOKEN_INVALID', message: 'token rejected'}}), {status: 422}),
      )
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
