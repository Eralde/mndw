import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {createReloadSentinel, restartService} from './dev-reload.js';

describe('createReloadSentinel', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();

    for (const root of tempRoots.splice(0)) {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('pre-creates a unique repo-local sentinel with counter zero and changes content on each touch', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'mndw-reload-test-'));
    tempRoots.push(repoRoot);

    const sentinel = createReloadSentinel(repoRoot);

    expect(sentinel.path).toMatch(/\.dev-data\/mndw-dev-reload\/session-[^/]+\/sentinel$/);
    expect(readFileSync(sentinel.path, 'utf8')).toBe('0\n');

    sentinel.touch();
    expect(readFileSync(sentinel.path, 'utf8')).toBe('1\n');
    sentinel.touch();
    expect(readFileSync(sentinel.path, 'utf8')).toBe('2\n');
    sentinel.cleanup();
  });

  it('creates isolated sentinel paths for concurrent sessions', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'mndw-reload-test-'));
    tempRoots.push(repoRoot);

    const first = createReloadSentinel(repoRoot);
    const second = createReloadSentinel(repoRoot);

    expect(first.path).not.toBe(second.path);
    first.cleanup();
    expect(() => readFileSync(second.path, 'utf8')).not.toThrow();
    second.cleanup();
  });

  it('cleans up sentinel session directory once', () => {
    const makeDir = vi.fn();
    const makeSessionDir = vi.fn(() => '/repo/.dev-data/mndw-dev-reload/session-one');
    const writeFile = vi.fn();
    const removeDir = vi.fn();
    const sentinel = createReloadSentinel('/repo', {makeDir, makeSessionDir, writeFile, removeDir});

    sentinel.cleanup();
    sentinel.cleanup();

    expect(makeDir).toHaveBeenCalledWith('/repo/.dev-data/mndw-dev-reload');
    expect(makeSessionDir).toHaveBeenCalledWith('/repo/.dev-data/mndw-dev-reload/session-');
    expect(writeFile).toHaveBeenCalledWith('/repo/.dev-data/mndw-dev-reload/session-one/sentinel', '0\n');
    expect(removeDir).toHaveBeenCalledTimes(1);
    expect(removeDir).toHaveBeenCalledWith('/repo/.dev-data/mndw-dev-reload/session-one');
    expect(removeDir).not.toHaveBeenCalledWith('/repo/.dev-data');
  });
});

describe('restartService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts plugin-wide restart request and accepts only HTTP 200', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, {status: 200}));

    await expect(restartService({daemonUrl: 'http://daemon.test', pluginName: 'sample-page'}, {fetch})).resolves.toBe(
      true,
    );

    expect(fetch).toHaveBeenCalledWith('http://daemon.test/api/mgmt/restart', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'sample-page'}),
      signal: expect.any(AbortSignal),
    });

    const noContentFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, {status: 204}));

    await expect(restartService({daemonUrl: 'http://daemon.test', pluginName: 'sample-page'}, {
      fetch: noContentFetch,
    })).resolves.toBe(false);
  });

  it('returns false for non-200 and network failures', async () => {
    const nonOkFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, {status: 500}));
    const failedFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));

    await expect(restartService({daemonUrl: 'http://daemon.test', pluginName: 'sample-page'}, {
      fetch: nonOkFetch,
    })).resolves.toBe(false);
    await expect(restartService({daemonUrl: 'http://daemon.test', pluginName: 'sample-page'}, {
      fetch: failedFetch,
    })).resolves.toBe(false);
  });

  it('aborts a stalled restart request at the bounded timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      })
    );
    const request = restartService({daemonUrl: 'http://daemon.test', pluginName: 'sample-page', timeoutMs: 5}, {fetch});

    await vi.advanceTimersByTimeAsync(5);

    await expect(request).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
