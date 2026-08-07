import {describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {controlDaemon, fetchHosts, fetchStats, updateHosts} from './ping';

function fakeBackend(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);

  return {backend: {fetch: fetchMock} as unknown as BackendClient, fetchMock};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {'content-type': 'application/json'},
    ...init,
  });
}

describe('ping services', () => {
  it('calls the start daemon binding', async () => {
    const {backend, fetchMock} = fakeBackend(jsonResponse({success: true}));

    await controlDaemon(backend, 'start');

    expect(fetchMock).toHaveBeenCalledWith('daemonStart');
  });

  it('calls the stop daemon binding', async () => {
    const {backend, fetchMock} = fakeBackend(jsonResponse({success: true}));

    await controlDaemon(backend, 'stop');

    expect(fetchMock).toHaveBeenCalledWith('daemonStop');
  });

  it('throws the daemon envelope message on failure', async () => {
    const {backend} = fakeBackend(jsonResponse({success: false, message: 'Daemon unavailable'}, {status: 500}));

    await expect(controlDaemon(backend, 'stop')).rejects.toThrow('Daemon unavailable');
  });

  it('fetchStats returns the data array from the envelope', async () => {
    const {backend, fetchMock} = fakeBackend(jsonResponse({
      success: true,
      data: [{
        ip: '1.1.1.1',
        lastMs: 5,
        avgMs: 5,
        medianMs: 5,
        minMs: 5,
        maxMs: 5,
        lossPercent: 0,
        sampleCount: 1,
        updatedAt: 't',
      }],
    }));
    const stats = await fetchStats(backend);

    expect(fetchMock).toHaveBeenCalledWith('stats');
    expect(stats).toHaveLength(1);
    expect(stats[0].ip).toBe('1.1.1.1');
  });

  it('fetchHosts returns [] when data is absent', async () => {
    const {backend} = fakeBackend(jsonResponse({success: true}));

    expect(await fetchHosts(backend)).toEqual([]);
  });

  it('updateHosts posts the body under the hostsUpdate id', async () => {
    const {backend, fetchMock} = fakeBackend(jsonResponse({success: true, data: [{ip: '2.2.2.2'}]}));
    const hosts = await updateHosts(backend, {action: 'add', ip: '2.2.2.2', name: 'x'});

    expect(fetchMock).toHaveBeenCalledWith('hostsUpdate', {body: {action: 'add', ip: '2.2.2.2', name: 'x'}});
    expect(hosts).toEqual([{ip: '2.2.2.2'}]);
  });

  it('throws the envelope message on success:false', async () => {
    const {backend} = fakeBackend(jsonResponse({success: false, message: 'boom'}));

    await expect(fetchStats(backend)).rejects.toThrow('boom');
  });

  it('throws on non-ok HTTP', async () => {
    const {backend} = fakeBackend(jsonResponse({}, {status: 502}));

    await expect(fetchStats(backend)).rejects.toThrow(/502/);
  });
});
