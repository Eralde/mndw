import type {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';
import type {BackendClient} from '@mndw/sdk';

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') || '';

  return contentType.toLowerCase().includes('application/json');
}

async function callTtydApi(
  backend: BackendClient,
  id: 'spawn' | 'kill',
  timeoutMs: number,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await backend.fetch(id, {body, signal: controller.signal});

    if (isJsonResponse(response)) {
      return response;
    }
  } finally {
    clearTimeout(timeoutId);
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
    : result.message || result.error;
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

export async function spawnCli(
  backend: BackendClient,
  consoleChoice: ConsoleChoice,
  retryIndex = 0,
): Promise<SpawnResult> {
  try {
    const response = await callTtydApi(backend, 'spawn', SPAWN_TIMEOUT_MS, {console: consoleChoice});

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

    if (result.success) {
      return {
        success: true,
        port: result.port || 7681,
      };
    }

    return buildSpawnError(result);
  } catch (error) {
    const errorType = classifyFetchError(error);

    if (retryIndex < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[retryIndex] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      await sleep(delay);

      return spawnCli(backend, consoleChoice, retryIndex + 1);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType,
    };
  }
}

export async function killCli(backend: BackendClient): Promise<{success: boolean}> {
  try {
    const response = await callTtydApi(backend, 'kill', SPAWN_TIMEOUT_MS, {});

    if (!response) {
      return {success: false};
    }

    return await response.json() as {success: boolean};
  } catch {
    return {success: false};
  }
}

export function connectToCli(
  backend: BackendClient,
  element: HTMLElement,
  TerminalCtor: typeof Terminal,
  FitAddonCtor: typeof FitAddon,
  onDisconnect?: (event: CloseEvent) => void,
): TerminalInstance {
  const socket = backend.socket('terminal');

  socket.binaryType = 'arraybuffer';

  const terminal = new TerminalCtor();
  const fitAddon = new FitAddonCtor();

  terminal.loadAddon(fitAddon);
  terminal.open(element);

  let socketReady = false;
  let gotFirstMessage = false;
  let disposed = false;
  const resizeObserver = new ResizeObserver(() => {
    if (!disposed) {
      fitAddon.fit();
    }
  });

  resizeObserver.observe(element);

  socket.addEventListener('open', () => {
    if (disposed) {
      return;
    }

    socketReady = true;

    const handshake = JSON.stringify({
      columns: terminal.cols,
      rows: terminal.rows,
    });

    socket.send(new TextEncoder().encode(handshake));
    terminal.focus();
  });

  socket.addEventListener('message', (event) => {
    if (disposed) {
      return;
    }

    if (!gotFirstMessage) {
      gotFirstMessage = true;
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    }

    const data = new Uint8Array(event.data as ArrayBuffer);
    const command = String.fromCharCode(data[0]);
    const payload = data.slice(1);

    if (command === '0') {
      terminal.write(payload);
    }
  });

  terminal.onData((data) => {
    if (!socketReady || disposed) {
      return;
    }

    const encoded = new TextEncoder().encode(data);
    const packet = new Uint8Array(encoded.length + 1);

    packet[0] = '0'.charCodeAt(0);
    packet.set(encoded, 1);
    socket.send(packet);
  });

  terminal.onResize(({cols, rows}) => {
    if (!socketReady || disposed) {
      return;
    }

    const resizePayload = JSON.stringify({columns: cols, rows});
    const packet = new TextEncoder().encode('1' + resizePayload);

    socket.send(packet);
  });

  socket.addEventListener('close', (event) => {
    socketReady = false;

    if (!disposed) {
      onDisconnect?.(event);
    }
  });

  return {
    terminal,
    fitAddon,
    dispose: () => {
      disposed = true;
      resizeObserver.disconnect();
      socket.close();
      terminal.dispose();
    },
  };
}
