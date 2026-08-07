import {beforeEach, describe, expect, it, vi} from 'vitest';

const {fetchWithDeadline} = vi.hoisted(() => ({
  fetchWithDeadline: vi.fn<(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number) => Promise<Response>>(),
}));

vi.mock('./pristine-fetch.js', () => ({fetchWithDeadline}));

import {ExtenderAccessService} from './extender-access.service.js';

describe('ExtenderAccessService', () => {
  beforeEach(() => {
    fetchWithDeadline.mockReset();
  });

  it('uses CSRF and bounded fetch for access state', async () => {
    fetchWithDeadline.mockResolvedValue(
      new Response(JSON.stringify({ok: true, status: 200, data: {enabled: true}}), {status: 200}),
    );

    const service = new ExtenderAccessService();

    await expect(service.getExtenderAccess()).resolves.toEqual({enabled: true});
    expect(fetchWithDeadline).toHaveBeenCalledWith('/api/mndw/extender-access', {
      headers: {'X-Mndw-Csrf': '1'},
    });
  });

  it('posts credentials and forget without exposing password in URL', async () => {
    fetchWithDeadline.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ok: true, status: 200}), {status: 200}))
    );

    const service = new ExtenderAccessService();

    await service.postCredentials({username: 'admin', password: 'secret'});
    await service.postForget();
    expect(fetchWithDeadline).toHaveBeenNthCalledWith(
      1,
      '/api/plugins/mws-map-page/credentials',
      expect.objectContaining({
        method: 'POST',
        body: '{"username":"admin","password":"secret"}',
      }),
    );
    expect(fetchWithDeadline).toHaveBeenNthCalledWith(
      2,
      '/api/plugins/mws-map-page/forget',
      expect.objectContaining({method: 'POST'}),
    );
  });
});
