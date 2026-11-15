import {afterEach, describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import type {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';
import {type ConnectOptions, connectToCli, spawnCli} from './cli.service';

function createSocket(): {
  socket: WebSocket;
  sendMock: ReturnType<typeof vi.fn>;
  wasClosed: () => boolean;
  dispatch(type: string, event?: Event): void;
} {
  const target = new EventTarget();
  const sendMock = vi.fn();
  let closed = false;
  const socket = {
    binaryType: '',
    close: vi.fn(() => {
      closed = true;
    }),
    send: sendMock,
    addEventListener: (type: string, listener: EventListener) => target.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListener) => target.removeEventListener(type, listener),
  } as unknown as WebSocket;

  return {
    socket,
    sendMock,
    wasClosed: () => closed,
    dispatch: (type, event = new Event(type)) => {
      if (type === 'close') {
        closed = true;
      }

      target.dispatchEvent(event);
    },
  };
}

function createConnectionHarness(
  socketFactory: () => WebSocket,
  options: ConnectOptions = {},
): {
  instance: ReturnType<typeof connectToCli>;
  socketFactory: ReturnType<typeof vi.fn>;
  terminal: Terminal;
} {
  const socket = vi.fn(socketFactory);
  const backendClient = {fetch: vi.fn(), socket} as unknown as BackendClient;
  const terminal = {
    cols: 80,
    dispose: vi.fn(),
    focus: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    open: vi.fn(),
    options: {disableStdin: false},
    rows: 24,
    write: vi.fn(),
  } as unknown as Terminal;
  const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
  const FitAddonCtor = vi.fn(() => ({fit: vi.fn()})) as unknown as typeof FitAddon;

  return {
    instance: connectToCli(backendClient, document.createElement('div'), TerminalCtor, FitAddonCtor, options),
    socketFactory: socket,
    terminal,
  };
}

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

  it('stops retrying when aborted during the retry sleep', async () => {
    vi.useFakeTimers();

    try {
      const fetch = vi.fn().mockRejectedValue(new TypeError('network error: failed to fetch'));
      const controller = new AbortController();
      const pending = spawnCli(backend(fetch), 'router', {signal: controller.signal});

      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);

      controller.abort();

      const result = await pending;

      expect(result.cancelled).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the in-flight spawn when aborted', async () => {
    const fetch = vi.fn((_id: string, options: {signal: AbortSignal}) => {
      return new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    const controller = new AbortController();
    const pending = spawnCli(backend(fetch), 'router', {signal: controller.signal});

    await Promise.resolve();
    controller.abort();

    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('focuses the terminal after the server responds to the websocket handshake', () => {
    const listeners = new Map<string, EventListener>();
    const socket = {
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) {
          listeners.delete(type);
        }
      }),
      binaryType: '',
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const socketFn = vi.fn(() => socket);
    const backendClient = {
      fetch: vi.fn(),
      socket: socketFn,
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
      options: {disableStdin: false},
      rows: 24,
      write: vi.fn(),
    } as unknown as Terminal;
    const fitAddon = {fit: vi.fn()} as unknown as FitAddon;
    const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
    const FitAddonCtor = vi.fn(() => fitAddon) as unknown as typeof FitAddon;

    const instance = connectToCli(backendClient, document.createElement('div'), TerminalCtor, FitAddonCtor);

    listeners.get('open')?.(new Event('open'));
    listeners.get('message')?.(new MessageEvent('message', {data: new Uint8Array([48]).buffer}));
    instance.activate();

    expect(socketFn).toHaveBeenCalledWith('terminal');
    expect(focus).toHaveBeenCalledOnce();
    instance.dispose();
  });

  it('keeps input disabled until the server responds to the websocket handshake', async () => {
    const socketEvents = createSocket();
    const {socket, sendMock} = socketEvents;
    const backendClient = {
      fetch: vi.fn(),
      socket: vi.fn(() => socket),
    } as unknown as BackendClient;
    const focus = vi.fn();
    let onData: ((data: string) => void) | undefined;
    const terminal = {
      cols: 80,
      dispose: vi.fn(),
      focus,
      loadAddon: vi.fn(),
      onData: (callback: (data: string) => void) => {
        onData = callback;
      },
      onResize: vi.fn(),
      open: vi.fn(),
      options: {disableStdin: false},
      rows: 24,
      write: vi.fn(),
    } as unknown as Terminal;
    const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
    const FitAddonCtor = vi.fn(() => ({fit: vi.fn()})) as unknown as typeof FitAddon;
    const instance = connectToCli(backendClient, document.createElement('div'), TerminalCtor, FitAddonCtor);
    let ready = false;

    void instance.ready.then(() => {
      ready = true;
    });

    expect(terminal.options.disableStdin).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(instance.ready).toBeInstanceOf(Promise);
    onData?.('pwd\n');
    expect(sendMock).not.toHaveBeenCalled();

    socketEvents.dispatch('open');
    await Promise.resolve();
    expect(ready).toBe(false);

    socketEvents.dispatch('message', new MessageEvent('message', {data: new Uint8Array([48]).buffer}));
    await instance.ready;

    expect(sendMock).toHaveBeenCalledOnce();
    expect(terminal.options.disableStdin).toBe(true);
    instance.activate();
    expect(terminal.options.disableStdin).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    onData?.('pwd\n');
    expect(sendMock).toHaveBeenCalledTimes(2);
    instance.dispose();
  });

  it('routes a maintenance close before readiness to disconnect instead of retrying', async () => {
    vi.useFakeTimers();

    const socketEvents = createSocket();
    const onDisconnect = vi.fn();
    const harness = createConnectionHarness(() => socketEvents.socket, {onDisconnect});
    const readiness = harness.instance.ready.then(
      () => null,
      (error: unknown) => error,
    );
    const closeEvent = Object.assign(new Event('close'), {code: 1012, reason: 'mndw updating'}) as CloseEvent;

    try {
      socketEvents.dispatch('open');
      socketEvents.dispatch('close', closeEvent);

      expect(onDisconnect).toHaveBeenCalledWith(closeEvent);
      expect(await readiness).toMatchObject({name: 'AbortError'});
      expect(harness.terminal.dispose.mock.calls).toHaveLength(1);
      expect(socketEvents.wasClosed()).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(harness.socketFactory).toHaveBeenCalledOnce();
    } finally {
      harness.instance.dispose();
      await vi.advanceTimersByTimeAsync(500);
      vi.useRealTimers();
    }
  });

  it.each(['timeout', 'abort', 'unmount'] as const)(
    'cancels a pending socket retry after %s and leaves the last socket closed',
    async (reason) => {
      vi.useFakeTimers();

      const first = createSocket();
      const second = createSocket();
      const sockets = [first, second];
      const controller = new AbortController();
      const harness = createConnectionHarness(() => sockets.shift()?.socket ?? second.socket, {
        signal: controller.signal,
      });

      void harness.instance.ready.catch(() => {});

      try {
        first.dispatch('close');

        if (reason === 'timeout') {
          const timeout = setTimeout(() => {
            controller.abort();
            harness.instance.dispose();
          }, 3000);

          await vi.advanceTimersByTimeAsync(100);
          await vi.advanceTimersByTimeAsync(2899);
          second.dispatch('close');
          await vi.advanceTimersByTimeAsync(1);
          clearTimeout(timeout);
          expect(harness.socketFactory).toHaveBeenCalledTimes(2);
          expect(second.wasClosed()).toBe(true);
        } else {
          if (reason === 'abort') {
            controller.abort();
          } else {
            controller.abort();
            harness.instance.dispose();
          }

          await vi.advanceTimersByTimeAsync(200);
          expect(harness.socketFactory).toHaveBeenCalledOnce();
          expect(first.wasClosed()).toBe(true);
        }

        await vi.advanceTimersByTimeAsync(200);
        expect(harness.socketFactory).toHaveBeenCalledTimes(reason === 'timeout' ? 2 : 1);

        expect(harness.terminal.dispose.mock.calls).toHaveLength(1);
      } finally {
        controller.abort();
        harness.instance.dispose();
        await vi.advanceTimersByTimeAsync(500);
        vi.useRealTimers();
      }
    },
  );

  it('closes the active socket when its owner aborts the connection', () => {
    const socketEvents = createSocket();
    const controller = new AbortController();
    const harness = createConnectionHarness(() => socketEvents.socket, {signal: controller.signal});

    void harness.instance.ready.catch(() => {});

    controller.abort();

    expect(socketEvents.socket.close.mock.calls).toHaveLength(1);
    expect(socketEvents.wasClosed()).toBe(true);
    expect(harness.terminal.dispose.mock.calls).toHaveLength(1);
    harness.instance.dispose();
  });

  it('retries a socket that closes before opening', async () => {
    vi.useFakeTimers();

    try {
      const first = createSocket();
      const second = createSocket();
      const socketFn = vi.fn()
        .mockReturnValueOnce(first.socket)
        .mockReturnValueOnce(second.socket);
      const backendClient = {fetch: vi.fn(), socket: socketFn} as unknown as BackendClient;
      const terminal = {
        cols: 80,
        dispose: vi.fn(),
        focus: vi.fn(),
        loadAddon: vi.fn(),
        onData: vi.fn(),
        onResize: vi.fn(),
        open: vi.fn(),
        options: {disableStdin: false},
        rows: 24,
        write: vi.fn(),
      } as unknown as Terminal;
      const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
      const FitAddonCtor = vi.fn(() => ({fit: vi.fn()})) as unknown as typeof FitAddon;
      const instance = connectToCli(backendClient, document.createElement('div'), TerminalCtor, FitAddonCtor);

      first.dispatch('close');
      await vi.advanceTimersByTimeAsync(100);

      expect(socketFn).toHaveBeenCalledTimes(2);
      second.dispatch('open');
      second.dispatch('message', new MessageEvent('message', {data: new Uint8Array([48]).buffer}));
      await instance.ready;
      instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the entware route for the entware console', () => {
    const socket = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      binaryType: '',
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const socketFn = vi.fn(() => socket);
    const backendClient = {
      fetch: vi.fn(),
      socket: socketFn,
    } as unknown as BackendClient;
    const terminal = {
      cols: 80,
      dispose: vi.fn(),
      focus: vi.fn(),
      loadAddon: vi.fn(),
      onData: vi.fn(),
      onResize: vi.fn(),
      open: vi.fn(),
      options: {disableStdin: false},
      rows: 24,
    } as unknown as Terminal;
    const fitAddon = {fit: vi.fn()} as unknown as FitAddon;
    const TerminalCtor = vi.fn(() => terminal) as unknown as typeof Terminal;
    const FitAddonCtor = vi.fn(() => fitAddon) as unknown as typeof FitAddon;

    const instance = connectToCli(
      backendClient,
      document.createElement('div'),
      TerminalCtor,
      FitAddonCtor,
      {console: 'entware'},
    );

    expect(socketFn).toHaveBeenCalledWith('terminal-entware');
    void instance.ready.catch(() => {});
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
      removeEventListener: vi.fn(),
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
      options: {disableStdin: false},
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

    void instance.ready.catch(() => {});
    instance.dispose();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
