import {afterEach, describe, expect, it, vi} from 'vitest';

describe('fetchWithDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('chains a caller-provided abort signal into the request', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;

      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('Request aborted', 'AbortError'));
        }, {once: true});
      });
    });

    vi.stubGlobal('fetch', fetch);
    vi.resetModules();
    const {fetchWithDeadline} = await import('./pristine-fetch.js');
    const parent = new AbortController();
    const pending = fetchWithDeadline('/api/mgmt/list', {signal: parent.signal});
    const rejected = expect(pending).rejects.toThrow(/aborted/i);

    parent.abort(new DOMException('Request aborted', 'AbortError'));

    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });
});
