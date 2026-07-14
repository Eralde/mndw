// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import PackageManager from './PackageManager.svelte';

function jsonResponse(body: unknown): Response {
  return {ok: true, json: () => Promise.resolve(body)} as Response;
}

describe('PackageManager', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
  });

  it('shows an empty catalog as an informational state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({packages: []}), {status: 200}));

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('No packages found');
    });

    expect(host.textContent).toContain('No packages found');
    await unmount(app);
  });

  it('shows a load error for a rejected list', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Failed to load packages');
    });

    expect(host.textContent).toContain('Failed to load packages');
    await unmount(app);
  });

  it('preserves action feedback after reloading the list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({packages: []}))
      .mockResolvedValueOnce(jsonResponse({ok: true, message: 'Package metadata refreshed'}))
      .mockResolvedValueOnce(jsonResponse({packages: []}));

    const app = mount(PackageManager, {target: host});

    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('No packages found');
    });

    const refreshButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.trim() === 'Refresh Metadata'
    );

    refreshButton?.click();
    flushSync();
    await vi.waitFor(() => expect(host.textContent).toContain('Package metadata refreshed'));
    await unmount(app);
  });
});
