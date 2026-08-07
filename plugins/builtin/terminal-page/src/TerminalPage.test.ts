// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import TerminalPage from './TerminalPage.svelte';

afterEach(() => vi.restoreAllMocks());

function notInstalledBackend(): {backend: BackendClient; fetch: ReturnType<typeof vi.fn>} {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({success: false, error: 'ttyd is not installed'}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    }),
  );

  return {backend: {fetch, socket: vi.fn()} as unknown as BackendClient, fetch};
}

function clickButton(host: HTMLElement, label: RegExp): void {
  const button = [...host.querySelectorAll('mndw-button')].find((b) => label.test(b.textContent ?? ''));

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  button.click();
}

describe('TerminalPage (dev path)', () => {
  it('renders both console buttons on the idle screen', () => {
    const {backend} = notInstalledBackend();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend}});

    flushSync();

    const labels = [...host.querySelectorAll('mndw-button')].map((b) => b.textContent ?? '');

    expect(labels.some((t) => /router cli/i.test(t))).toBe(true);
    expect(labels.some((t) => /entware shell/i.test(t))).toBe(true);

    void unmount(app);
    host.remove();
  });

  it('sends the router console when Router CLI is clicked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const {backend, fetch} = notInstalledBackend();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend}});

    flushSync();
    clickButton(host, /router cli/i);

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('spawn', expect.objectContaining({body: {console: 'router'}}))
    );

    void unmount(app);
    host.remove();
  });

  it('reuses the selected console when Retry is clicked after a spawn error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const {backend, fetch} = notInstalledBackend();
    const host = document.createElement('div');

    document.body.appendChild(host);

    const app = mount(TerminalPage, {target: host, props: {backend}});

    flushSync();
    clickButton(host, /entware shell/i);

    await vi.waitFor(() => expect(host.textContent ?? '').toMatch(/not installed/i));
    clickButton(host, /retry/i);
    await vi.waitFor(() => expect(fetch.mock.calls.filter((c) => c[0] === 'spawn').length).toBe(2));

    for (const call of fetch.mock.calls.filter((c) => c[0] === 'spawn')) {
      expect(call[1]).toEqual(expect.objectContaining({body: {console: 'entware'}}));
    }

    void unmount(app);
    host.remove();
  });
});
