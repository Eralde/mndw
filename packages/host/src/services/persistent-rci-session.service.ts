import {fetchWithDeadline} from './pristine-fetch.js';

export type PersistentStoreState = 'ok' | 'empty' | 'disabled' | 'decrypt-failed';
export type PersistentSupport = 'supported' | 'invalid' | 'unsupported' | 'unknown';

export interface PersistentRciCapability {
  store: {state: PersistentStoreState};
  controller: {support: PersistentSupport; lastCheckedAt?: string};
  extenders: Array<{
    identity: string;
    name: string;
    support: PersistentSupport;
    lastCheckedAt?: string;
    lastError?: string;
  }>;
}

export interface ControllerTestResult {
  result: 'valid' | 'invalid-token' | 'unsupported-firmware' | 'unreachable';
}

export interface ProvisionResult {
  extenders: Array<{identity: string; support: PersistentSupport}>;
}

export interface PersistentRciCredentials {
  username: string;
  password: string;
}

export class PersistentRciSessionError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'PersistentRciSessionError';
    this.code = code;
    this.status = status;
  }
}

const BASE_URL = '/api/mndw/rci-session';
const CONTROLLER_TOKEN_PROBE = {probe: 'authentication token generate'};

export class PersistentRciSessionService {
  public async probeControllerTokenAuth(): Promise<boolean> {
    try {
      const response = await fetchWithDeadline('/rci/', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(CONTROLLER_TOKEN_PROBE),
      });

      if (!response.ok) {
        return false;
      }

      const text = await response.text();

      if (text === '') {
        return false;
      }

      const payload: unknown = JSON.parse(text);

      return this.controllerProbeFound(payload);
    } catch {
      return false;
    }
  }

  public async getCapability(): Promise<PersistentRciCapability> {
    return await this.read<PersistentRciCapability>(
      await fetchWithDeadline(`${BASE_URL}/capability`, {
        headers: {'X-Mndw-Csrf': '1'},
      }),
    );
  }

  public async testController(token: string): Promise<ControllerTestResult> {
    return await this.read<ControllerTestResult>(await this.post('/controller/test', {token}));
  }

  public async saveController(token: string): Promise<ControllerTestResult> {
    return await this.read<ControllerTestResult>(await this.post('/controller', {token}));
  }

  public async clearController(): Promise<void> {
    await this.read(
      await fetchWithDeadline(`${BASE_URL}/controller`, {
        method: 'DELETE',
        headers: {'X-Mndw-Csrf': '1'},
      }),
    );
  }

  public async provisionExtenders(credentials: PersistentRciCredentials): Promise<ProvisionResult> {
    return await this.read<ProvisionResult>(await this.post('/extenders/provision', credentials));
  }

  public async clearExtenders(): Promise<void> {
    await this.read(
      await fetchWithDeadline(`${BASE_URL}/extenders`, {
        method: 'DELETE',
        headers: {'X-Mndw-Csrf': '1'},
      }),
    );
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return await fetchWithDeadline(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Mndw-Csrf': '1'},
      body: JSON.stringify(body),
    });
  }

  private async read<T = unknown>(response: Response): Promise<T> {
    const text = await response.text();
    let payload: unknown;

    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new PersistentRciSessionError('MALFORMED_RESPONSE', response.status);
    }

    if (!response.ok) {
      const code = this.errorCode(payload) ?? `HTTP_${response.status}`;

      throw new PersistentRciSessionError(code, response.status);
    }

    return payload as T;
  }

  private errorCode(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const error = (payload as {error?: unknown}).error;

      if (
        error && typeof error === 'object' && 'code' in error && typeof (error as {code?: unknown}).code === 'string'
      ) {
        return (error as {code: string}).code;
      }
    }

    return undefined;
  }

  private controllerProbeFound(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object' || !('probe' in payload)) {
      return false;
    }

    const probe = (payload as {probe?: unknown}).probe;

    return probe !== null
      && typeof probe === 'object'
      && 'found' in probe
      && (probe as {found?: unknown}).found === true;
  }
}

export const persistentRciSessionService = new PersistentRciSessionService();
