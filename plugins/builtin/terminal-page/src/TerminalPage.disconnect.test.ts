// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import enCatalog from '../i18n/en.json';
import ruCatalog from '../i18n/ru.json';

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
        ready: Promise.resolve(),
        activate: vi.fn(),
        dispose: vi.fn(),
      };
    });
  });

  function pendingConnection(): {
    connection: {
      terminal: object;
      fitAddon: {fit: ReturnType<typeof vi.fn>};
      ready: Promise<void>;
      activate: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };
    resolveReady: () => void;
  } {
    let resolveReady = (): void => {};
    let rejectReady = (_error: unknown): void => {};
    const connection = {
      terminal: {},
      fitAddon: {fit: vi.fn()},
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      activate: vi.fn(),
      dispose: vi.fn(() => rejectReady(new DOMException('The operation was aborted', 'AbortError'))),
    };

    return {connection, resolveReady};
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
  }

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

  it('shows Connecting until the websocket readiness promise resolves', async () => {
    vi.useFakeTimers();

    const pending = pendingConnection();

    mocks.connectToCli.mockReturnValueOnce(pending.connection);

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(host.textContent).toContain('Connecting…');
    expect(host.textContent).not.toContain('Connected');

    const connectingStatus = host.querySelector('[role="status"]');

    expect(connectingStatus).not.toBeNull();
    expect(connectingStatus?.closest('[inert]')).toBeNull();

    pending.resolveReady();
    await flushPromises();

    expect(host.textContent).toContain('Connected');
    expect(pending.connection.activate).toHaveBeenCalledOnce();

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('keeps the maintenance disconnect state after a pre-ready close', async () => {
    vi.useFakeTimers();

    const pending = pendingConnection();
    let connectionSignal: AbortSignal | undefined;

    mocks.connectToCli.mockImplementationOnce((...args: unknown[]) => {
      const options = args[4] as {onDisconnect?: (event: CloseEvent) => void; signal?: AbortSignal} | undefined;

      onDisconnect = options?.onDisconnect;
      connectionSignal = options?.signal;

      return pending.connection;
    });

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(host.textContent).toContain('Connecting…');

    onDisconnect?.({code: 1012, reason: 'mndw updating'} as CloseEvent);
    flushSync();

    expect(host.textContent).toContain('Session ended during update');
    expect(connectionSignal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    flushSync();

    expect(host.textContent).toContain('Session ended during update');
    expect(host.textContent).not.toContain('Terminal did not connect within 3 seconds');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('times out readiness after three seconds, disposes the attempt, and offers Retry', async () => {
    vi.useFakeTimers();

    const pending = pendingConnection();
    const i18n = createTestI18n(enCatalog);
    let connectionSignal: AbortSignal | undefined;

    mocks.connectToCli.mockImplementationOnce((...args: unknown[]) => {
      const options = args[4] as {signal?: AbortSignal} | undefined;

      connectionSignal = options?.signal;

      return pending.connection;
    });

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n}});

    flushSync();
    clickButton(host, /router cli/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(host.textContent).toContain('Connecting…');

    await vi.advanceTimersByTimeAsync(3000);
    flushSync();

    expect(host.textContent).toContain('Terminal did not connect within 3 seconds');
    expect(connectionSignal?.aborted).toBe(true);
    expect(pending.connection.dispose).toHaveBeenCalledOnce();
    expect([...host.querySelectorAll('mndw-button')].some((button) => /retry/i.test(button.textContent ?? '')))
      .toBe(true);

    i18n.setLocale('ru', ruCatalog);
    flushSync();
    expect(host.textContent).toContain('Терминал не подключился за 3 с');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('switches consoles from the error state without leaving the page', async () => {
    vi.useFakeTimers();
    mocks.spawnCli.mockResolvedValueOnce({success: false, error: 'spawn failed'});

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(host.textContent).toContain('Failed to start terminal service');

    clickButton(host, /entware shell/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(mocks.spawnCli).toHaveBeenCalledTimes(2);
    expect(mocks.spawnCli.mock.calls[1]?.[1]).toBe('entware');
    expect(host.textContent).toContain('Connected');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('switches consoles from the disconnected state without leaving the page', async () => {
    vi.useFakeTimers();

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    onDisconnect?.({code: 1006, reason: ''} as CloseEvent);
    flushSync();

    expect(host.textContent).toContain('Connection lost');
    clickButton(host, /entware shell/i);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(mocks.spawnCli).toHaveBeenCalledTimes(2);
    expect(mocks.spawnCli.mock.calls[1]?.[1]).toBe('entware');
    expect(host.textContent).toContain('Connected');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('aborts and disposes a pending connection when switching consoles', async () => {
    vi.useFakeTimers();

    const pending = pendingConnection();
    let connectionSignal: AbortSignal | undefined;

    mocks.connectToCli.mockImplementationOnce((...args: unknown[]) => {
      const options = args[4] as {signal?: AbortSignal} | undefined;

      connectionSignal = options?.signal;

      return pending.connection;
    });

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(host.textContent).toContain('Connecting…');

    clickButton(host, /entware shell/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(connectionSignal?.aborted).toBe(true);
    expect(pending.connection.dispose).toHaveBeenCalledOnce();
    expect(mocks.spawnCli.mock.calls.at(-1)?.[1]).toBe('entware');
    expect(host.textContent).toContain('Connected');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });

  it('keeps the console choice available while starting and cancels the old spawn', async () => {
    vi.useFakeTimers();

    let resolveFirstSpawn = (_result: {success: boolean; port: number}): void => {};

    mocks.spawnCli.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveFirstSpawn = resolve;
      })
    );

    const host = document.createElement('div');

    document.body.appendChild(host);

    const {client} = backendClient();
    const app = mount(TerminalPage, {target: host, props: {backend: client, i18n: createTestI18n(enCatalog)}});

    flushSync();
    clickButton(host, /router cli/i);
    await flushPromises();

    expect(host.textContent).toContain('Starting terminal…');
    expect([...host.querySelectorAll('mndw-button')].some((button) => /entware shell/i.test(button.textContent ?? '')))
      .toBe(true);

    mocks.spawnCli.mockResolvedValueOnce({success: true, port: 7681});
    clickButton(host, /entware shell/i);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    resolveFirstSpawn({success: true, port: 7681});
    await flushPromises();

    expect(mocks.spawnCli).toHaveBeenCalledTimes(2);
    expect(mocks.spawnCli.mock.calls[1]?.[1]).toBe('entware');
    expect(mocks.connectToCli).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Connected');

    void unmount(app);
    host.remove();
    vi.useRealTimers();
  });
});
