import {afterEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import type {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';
import {connectToCli, killCli, spawnCli} from './cli.service';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

function backend(fetch: ReturnType<typeof vi.fn>): BackendClient {
  return {fetch, socket: vi.fn()} as unknown as BackendClient;
}

describe('cli.service', () => {
  it('spawnCli returns success + port and sends the console on the body', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({success: true, port: 7681}));

    const result = await spawnCli(backend(fetch), 'router');

    expect(result).toEqual({success: true, port: 7681});
    expect(fetch).toHaveBeenCalledWith('spawn', expect.objectContaining({body: {console: 'router'}}));
  });

  it('spawnCli classifies the backend TTYD_NOT_INSTALLED error', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: false,
      error: 'TTYD_NOT_INSTALLED',
      message: 'ttyd is not installed',
    }));

    const result = await spawnCli(backend(fetch), 'entware');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('SPAWN_FAILED');
    expect(result.errorCode).toBe('TTYD_NOT_INSTALLED');
    expect(result.error).toBe('ttyd is not installed');
    expect(fetch).toHaveBeenCalledWith('spawn', expect.objectContaining({body: {console: 'entware'}}));
  });

  it('preserves unknown backend error codes for page-level copy mapping', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: false,
      code: 'PORT_IN_USE',
      error: 'port 7681 is already in use',
    }));

    const result = await spawnCli(backend(fetch), 'router');

    expect(result.errorCode).toBe('PORT_IN_USE');
    expect(result.error).toContain('already in use');
  });

  it('spawnCli forwards the console on every retry', async () => {
    vi.useFakeTimers();

    try {
      const fetch = vi.fn().mockRejectedValue(new TypeError('network error: failed to fetch'));
      const pending = spawnCli(backend(fetch), 'entware');

      // Drive the three backoff delays (1000 + 2000 + 4000 ms) to exhaustion.
      await vi.advanceTimersByTimeAsync(8000);

      const result = await pending;

      expect(result.success).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(4);

      for (const call of fetch.mock.calls) {
        expect(call[0]).toBe('spawn');
        expect(call[1]).toEqual(expect.objectContaining({body: {console: 'entware'}}));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('killCli returns the parsed success flag', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({success: true}));

    expect(await killCli(backend(fetch))).toEqual({success: true});
    expect(fetch).toHaveBeenCalledWith('kill', expect.objectContaining({body: {}}));
  });

  it('focuses the terminal when the websocket opens', () => {
    const listeners = new Map<string, EventListener>();
    const socket = {
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      binaryType: '',
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const backendClient = {
      fetch: vi.fn(),
      socket: vi.fn(() => socket),
    } as unknown as BackendClient;
    const focus = vi.fn();
    const terminal = {
      cols: 80,
      dispose: vi.fn(),
      focus,
      loadAddon: vi.fn(),
      onData: vi.fn(),
      onResize: vi.fn(),
      open: vi.fn(),
      rows: 24,
    } as unknown as Terminal;
    const fitAddon = {fit: vi.fn()} as unknown as FitAddon;
    const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
    const FitAddonCtor = vi.fn(() => fitAddon) as unknown as typeof FitAddon;

    const instance = connectToCli(backendClient, document.createElement('div'), TerminalCtor, FitAddonCtor);

    listeners.get('open')?.(new Event('open'));

    expect(focus).toHaveBeenCalledOnce();
    instance.dispose();
  });

  it('fits the terminal when its container changes size and disconnects the observer', () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();

    vi.stubGlobal(
      'ResizeObserver',
      vi.fn((callback: ResizeObserverCallback) => {
        resizeCallback = callback;

        return {disconnect, observe};
      }),
    );

    const socket = {
      addEventListener: vi.fn(),
      binaryType: '',
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const backendClient = {
      fetch: vi.fn(),
      socket: vi.fn(() => socket),
    } as unknown as BackendClient;
    const terminal = {
      cols: 80,
      dispose: vi.fn(),
      focus: vi.fn(),
      loadAddon: vi.fn(),
      onData: vi.fn(),
      onResize: vi.fn(),
      open: vi.fn(),
      rows: 24,
    } as unknown as Terminal;
    const fit = vi.fn();
    const fitAddon = {fit} as unknown as FitAddon;
    const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
    const FitAddonCtor = vi.fn(() => fitAddon) as unknown as typeof FitAddon;
    const element = document.createElement('div');

    const instance = connectToCli(backendClient, element, TerminalCtor, FitAddonCtor);

    expect(observe).toHaveBeenCalledWith(element);
    expect(resizeCallback).toBeDefined();
    resizeCallback?.([], {} as ResizeObserver);
    expect(fit).toHaveBeenCalledOnce();

    instance.dispose();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
