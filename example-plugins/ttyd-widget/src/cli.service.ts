import type {FitAddon} from '@xterm/addon-fit';
import type {Terminal} from '@xterm/xterm';

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

export interface SpawnResult {
  success: boolean;
  port?: number;
  error?: string;
  errorType?: ConnectionError;
}

interface SpawnApiResponse {
  success: boolean;
  port?: number;
  error?: string;
}

const SPAWN_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') || '';

  return contentType.toLowerCase().includes('application/json');
}

async function callTtydApi(
  endpoint: string,
  timeoutMs: number,
): Promise<{response: Response; endpoint: string} | null> {
  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({}),
      },
      timeoutMs,
    );

    if (isJsonResponse(response)) {
      return {response, endpoint};
    }
  } catch {
    // Try the next endpoint
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
  const error = result.error || 'Failed to spawn ttyd';
  const lower = error.toLowerCase();

  if (lower.includes('already')) {
    return {
      success: true,
      port: result.port || 7681,
    };
  }

  return {
    success: false,
    error,
    errorType: 'SPAWN_FAILED',
  };
}

export async function spawnCli(endpoint: string, retryIndex = 0): Promise<SpawnResult> {
  try {
    const hit = await callTtydApi(endpoint, SPAWN_TIMEOUT_MS);

    if (!hit) {
      return {
        success: false,
        error: 'No ttyd endpoint responded with JSON.',
        errorType: 'SPAWN_FAILED',
      };
    }

    const {response} = hit;

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

      return spawnCli(endpoint, retryIndex + 1);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType,
    };
  }
}

export async function killCli(endpoint: string): Promise<{success: boolean}> {
  try {
    const hit = await callTtydApi(endpoint, SPAWN_TIMEOUT_MS);

    if (!hit) {
      return {success: false};
    }

    return await hit.response.json() as {success: boolean};
  } catch {
    return {success: false};
  }
}

export function connectToCli(
  websocketPath: string,
  element: HTMLElement,
  TerminalCtor: typeof Terminal,
  FitAddonCtor: typeof FitAddon,
  onDisconnect?: () => void,
): TerminalInstance {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}${websocketPath}`;
  const socket = new WebSocket(wsUrl, ['tty']);

  socket.binaryType = 'arraybuffer';

  const terminal = new TerminalCtor();
  const fitAddon = new FitAddonCtor();

  terminal.loadAddon(fitAddon);
  terminal.open(element);

  let socketReady = false;
  let gotFirstMessage = false;
  let disposed = false;

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

  socket.addEventListener('close', () => {
    socketReady = false;

    if (!disposed) {
      onDisconnect?.();
    }
  });

  return {
    terminal,
    fitAddon,
    dispose: () => {
      disposed = true;
      socket.close();
      terminal.dispose();
    },
  };
}
