// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';

const mocks = vi.hoisted(() => ({
  connectToCli: vi.fn(),
  spawnCli: vi.fn(),
}));

vi.mock('./cli.service.js', () => ({
  connectToCli: mocks.connectToCli,
  spawnCli: mocks.spawnCli,
}));

import TerminalPage from './TerminalPage.svelte';

function clickButton(host: HTMLElement, label: RegExp): void {
  const button = [...host.querySelectorAll('mndw-button')].find((candidate) => label.test(candidate.textContent ?? ''));

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  button.click();
}

function backendClient(): {client: BackendClient; fetch: ReturnType<typeof vi.fn>} {
  const fetch = vi.fn();

  return {
    client: {fetch, socket: vi.fn()} as unknown as BackendClient,
    fetch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalPage disconnect reason', () => {
  let onDisconnect: ((event: CloseEvent) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onDisconnect = undefined;
    mocks.spawnCli.mockResolvedValue({success: true, port: 7681});
    mocks.connectToCli.mockImplementation((...args: unknown[]) => {
      const options = args[4] as {onDisconnect?: (event: CloseEvent) => void} | undefined;

      onDisconnect = options?.onDisconnect;

      return {
        terminal: {},
        fitAddon: {fit: vi.fn()},
        dispose: vi.fn(),
      };
    });
  });

  async function mountConnected(): Promise<{
    host: HTMLElement;
    app: ReturnType<typeof mount>;
    fetch: ReturnType<typeof vi.fn>;
  }> {
    vi.useFakeTimers();

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client, fetch} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);

    await vi.advanceTimersByTimeAsync(1000);
    flushSync();

    return {host, app, fetch};
  }

  it('renders the update-ended reason and a reconnect action', async () => {
    const {host, app} = await mountConnected();

    expect(mocks.connectToCli).toHaveBeenCalledOnce();

    onDisconnect?.({code: 1012, reason: 'mndw updating'} as CloseEvent);
    flushSync();

    expect(host.textContent).toContain('Session ended during update');
    expect(host.textContent).not.toContain('Connection lost');
    expect([...host.querySelectorAll('mndw-button')].some((button) => /reconnect/i.test(button.textContent ?? '')))
      .toBe(
        true,
      );

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('does not call kill when a connected page unmounts', async () => {
    const {host, app, fetch} = await mountConnected();

    expect(mocks.connectToCli).toHaveBeenCalledOnce();

    void unmount(app);

    await Promise.resolve();

    expect(fetch.mock.calls.filter((call) => call[0] === 'kill')).toHaveLength(0);
    host.remove();
  });

  it('renders the connection-lost reason for an ordinary close', async () => {
    const {host, app} = await mountConnected();

    onDisconnect?.({code: 1006, reason: ''} as CloseEvent);
    flushSync();

    expect(host.textContent).toContain('Connection lost');
    expect(host.textContent).not.toContain('Session ended during update');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });
});
