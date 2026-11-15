import type {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';
import {type BackendClient, isBackendMaintenanceClose} from '@mndw/sdk';

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  ready: Promise<void>;
  activate: () => void;
  dispose: () => void;
}

export type ConnectionError =
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'AUTH_FAILED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export type ConsoleChoice = 'router' | 'entware';

export interface SpawnResult {
  success: boolean;
  port?: number;
  error?: string;
  errorType?: ConnectionError;
  errorCode?: string;
  cancelled?: boolean;
}

export interface SpawnOptions {
  signal?: AbortSignal;
}

export interface ConnectOptions {
  console?: ConsoleChoice;
  signal?: AbortSignal;
  onDisconnect?: (event: CloseEvent) => void;
}

interface SpawnApiResponse {
  success: boolean;
  port?: number;
  error?: string;
  message?: string;
  code?: string;
  errorCode?: string;
}

const SPAWN_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const SOCKET_RETRY_DELAY_MS = 100;
const CONSOLE_ROUTES: Record<ConsoleChoice, string> = {
  router: 'terminal',
  entware: 'terminal-entware',
};

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());

      return;
    }

    const pending = {
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const onAbort = () => {
      clearTimeout(pending.timer);
      reject(abortError());
    };

    pending.timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') || '';

  return contentType.toLowerCase().includes('application/json');
}

async function callTtydApi(
  backend: BackendClient,
  id: 'spawn',
  timeoutMs: number,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response | null> {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  const timeoutId = setTimeout(abort, timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', abort, {once: true});
    }
  }

  try {
    const response = await backend.fetch(id, {body, signal: controller.signal});

    if (isJsonResponse(response)) {
      return response;
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }

  return null;
}

function classifyFetchError(error: unknown): ConnectionError {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'TIMEOUT';
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes('timeout') || message.includes('abort')) {
      return 'TIMEOUT';
    }

    if (message.includes('network') || message.includes('failed to fetch')) {
      return 'NETWORK_ERROR';
    }
  }

  return 'UNKNOWN';
}

function buildSpawnError(result: SpawnApiResponse): SpawnResult {
  const directErrorCode = result.error === 'TTYD_NOT_INSTALLED' ? result.error : undefined;
  const error = directErrorCode === undefined
    ? result.error || result.message || 'Failed to spawn ttyd'
    : result.message || result.error || 'Failed to spawn ttyd';
  const lower = error.toLowerCase();

  const backendErrorCode = result.code ?? result.errorCode ?? directErrorCode;

  if (backendErrorCode === undefined && lower.includes('already')) {
    return {
      success: true,
      port: result.port || 7681,
    };
  }

  return {
    success: false,
    error,
    errorType: 'SPAWN_FAILED',
    errorCode: backendErrorCode,
  };
}

function cancelledResult(): SpawnResult {
  return {
    success: false,
    cancelled: true,
    error: 'Cancelled',
    errorType: 'UNKNOWN',
  };
}

export async function spawnCli(
  backend: BackendClient,
  consoleChoice: ConsoleChoice,
  options: SpawnOptions = {},
  retryIndex = 0,
): Promise<SpawnResult> {
  try {
    const response = await callTtydApi(backend, 'spawn', SPAWN_TIMEOUT_MS, {console: consoleChoice}, options.signal);

    if (options.signal?.aborted) {
      return cancelledResult();
    }

    if (!response) {
      return {
        success: false,
        error: 'No ttyd endpoint responded with JSON.',
        errorType: 'SPAWN_FAILED',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error: 'Access denied',
        errorType: 'AUTH_FAILED',
      };
    }

    const result = await response.json() as SpawnApiResponse;

    if (options.signal?.aborted) {
      return cancelledResult();
    }

    if (result.success) {
      return {
        success: true,
        port: result.port || 7681,
      };
    }

    return buildSpawnError(result);
  } catch (error) {
    if (options.signal?.aborted) {
      return cancelledResult();
    }

    const errorType = classifyFetchError(error);

    if (retryIndex < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[retryIndex] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      try {
        await sleep(delay, options.signal);
      } catch {
        return cancelledResult();
      }

      if (options.signal?.aborted) {
        return cancelledResult();
      }

      return spawnCli(backend, consoleChoice, options, retryIndex + 1);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType,
    };
  }
}

export function connectToCli(
  backend: BackendClient,
  element: HTMLElement,
  TerminalCtor: typeof Terminal,
  FitAddonCtor: typeof FitAddon,
  options: ConnectOptions = {},
): TerminalInstance {
  const terminal = new TerminalCtor();
  const fitAddon = new FitAddonCtor();

  terminal.options.disableStdin = true;
  terminal.loadAddon(fitAddon);
  terminal.open(element);

  let socketReady = false;
  let gotFirstMessage = false;
  let receivedServerMessage = false;
  let handshakeSent = false;
  let disposed = false;
  let readySettled = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let removeSocketListeners: (() => void) | undefined;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const resizeObserver = new ResizeObserver(() => {
    if (!disposed) {
      fitAddon.fit();
    }
  });

  resizeObserver.observe(element);

  const resetSocket = (currentSocket: WebSocket, close: boolean): void => {
    if (socket !== currentSocket) {
      return;
    }

    removeSocketListeners?.();
    removeSocketListeners = undefined;
    socket = null;
    socketReady = false;
    receivedServerMessage = false;
    handshakeSent = false;

    if (close) {
      currentSocket.close();
    }
  };

  const resolveReadiness = (): void => {
    if (disposed || readySettled || !handshakeSent || !receivedServerMessage) {
      return;
    }

    socketReady = true;
    readySettled = true;
    resolveReady?.();
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    clearTimeout(retryTimer);
    retryTimer = undefined;
    resizeObserver.disconnect();

    if (socket) {
      resetSocket(socket, true);
    }

    terminal.dispose();

    if (!readySettled) {
      readySettled = true;
      rejectReady?.(abortError());
    }
  };

  const scheduleRetry = (retry: () => void): void => {
    if (disposed || retryTimer !== undefined) {
      return;
    }

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retry();
    }, SOCKET_RETRY_DELAY_MS);
  };

  const openSocket = (): void => {
    if (disposed) {
      return;
    }

    let currentSocket: WebSocket;

    try {
      currentSocket = backend.socket(CONSOLE_ROUTES[options.console ?? 'router']);
      currentSocket.binaryType = 'arraybuffer';
    } catch {
      scheduleRetry(openSocket);

      return;
    }

    socket = currentSocket;

    const onOpen = (): void => {
      if (disposed || socket !== currentSocket) {
        return;
      }

      const handshake = JSON.stringify({
        columns: terminal.cols,
        rows: terminal.rows,
      });

      try {
        currentSocket.send(new TextEncoder().encode(handshake));
      } catch {
        resetSocket(currentSocket, true);
        scheduleRetry(openSocket);

        return;
      }

      handshakeSent = true;
      resolveReadiness();
    };

    const onMessage = (event: MessageEvent): void => {
      if (disposed || socket !== currentSocket) {
        return;
      }

      if (!gotFirstMessage) {
        gotFirstMessage = true;
        requestAnimationFrame(() => {
          if (!disposed) {
            fitAddon.fit();
          }
        });
      }

      receivedServerMessage = true;

      const data = new Uint8Array(event.data as ArrayBuffer);
      const command = String.fromCharCode(data[0]);
      const payload = data.slice(1);

      if (command === '0') {
        terminal.write(payload);
      }

      resolveReadiness();
    };

    const onClose = (event: CloseEvent): void => {
      if (disposed || socket !== currentSocket) {
        return;
      }

      if (!readySettled) {
        resetSocket(currentSocket, false);

        if (isBackendMaintenanceClose(event)) {
          readySettled = true;
          rejectReady?.(abortError());
          options.onDisconnect?.(event);
          dispose();

          return;
        }

        scheduleRetry(openSocket);

        return;
      }

      socketReady = false;
      options.onDisconnect?.(event);
    };

    const onError = (): void => {
      if (!readySettled && socket === currentSocket) {
        resetSocket(currentSocket, true);
        scheduleRetry(openSocket);
      }
    };

    currentSocket.addEventListener('open', onOpen);
    currentSocket.addEventListener('message', onMessage);
    currentSocket.addEventListener('close', onClose);
    currentSocket.addEventListener('error', onError);
    removeSocketListeners = () => {
      currentSocket.removeEventListener('open', onOpen);
      currentSocket.removeEventListener('message', onMessage);
      currentSocket.removeEventListener('close', onClose);
      currentSocket.removeEventListener('error', onError);
    };
  };

  openSocket();

  if (options.signal?.aborted) {
    dispose();
  } else {
    options.signal?.addEventListener('abort', dispose, {once: true});
  }

  terminal.onData((data) => {
    const currentSocket = socket;

    if (!socketReady || disposed || !currentSocket) {
      return;
    }

    const encoded = new TextEncoder().encode(data);
    const packet = new Uint8Array(encoded.length + 1);

    packet[0] = '0'.charCodeAt(0);
    packet.set(encoded, 1);
    currentSocket.send(packet);
  });

  terminal.onResize(({cols, rows}) => {
    const currentSocket = socket;

    if (!socketReady || disposed || !currentSocket) {
      return;
    }

    const resizePayload = JSON.stringify({columns: cols, rows});
    const packet = new TextEncoder().encode('1' + resizePayload);

    currentSocket.send(packet);
  });

  return {
    terminal,
    fitAddon,
    ready,
    activate: () => {
      if (disposed || !socketReady) {
        return;
      }

      terminal.options.disableStdin = false;
      terminal.focus();
    },
    dispose,
  };
}
