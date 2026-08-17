import {persistentFailureCategories} from './rci-session-status-categories.js';
import {fetchWithDeadline} from './pristine-fetch.js';

export type PersistentStoreState = 'ok' | 'empty' | 'disabled' | 'decrypt-failed';
export type PersistentSupport = 'supported' | 'invalid' | 'unsupported' | 'unknown';
export type PersistentSessionState = 'offline' | 'establishing' | 'live' | 'dead';
export type PersistentEligibilityReason = 'certificate-invalid' | 'no-auth-token' | 'missing-fqdn';
export type PersistentFailureCategory = (typeof persistentFailureCategories)[number];

export interface PersistentRciCapability {
  store: {state: PersistentStoreState};
  controller: {support: PersistentSupport; lastCheckedAt?: string};
  extenders: Array<{
    identity: string;
    name: string;
    eligible: boolean;
    reason?: PersistentEligibilityReason;
    state?: PersistentSessionState;
    lastError?: PersistentFailureCategory;
    lastHeartbeatAt?: string;
  }>;
  stale: boolean;
  lastEnumerationError?: PersistentFailureCategory;
  lastEnumerationErrorAt?: string;
}

export interface ControllerTestResult {
  result: 'valid' | 'invalid-token' | 'unsupported-firmware' | 'unreachable';
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
const sessionStates = ['offline', 'establishing', 'live', 'dead'] as const;
const eligibilityReasons = ['certificate-invalid', 'no-auth-token', 'missing-fqdn'] as const;
const supports = ['supported', 'invalid', 'unsupported', 'unknown'] as const;
const storeStates = ['ok', 'empty', 'disabled', 'decrypt-failed'] as const;

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
      return this.controllerProbeFound(JSON.parse(text) as unknown);
    } catch {
      return false;
    }
  }

  public async getCapability(): Promise<PersistentRciCapability> {
    const payload = await this.read<unknown>(
      await fetchWithDeadline(`${BASE_URL}/capability`, {
        headers: {'X-Mndw-Csrf': '1'},
      }),
    );
    return this.parseCapability(payload);
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

  private parseCapability(payload: unknown): PersistentRciCapability {
    if (
      !this.isRecord(payload) || !this.isRecord(payload.store) || !this.isRecord(payload.controller)
      || !Array.isArray(payload.extenders) || typeof payload.stale !== 'boolean'
      || !this.isStoreState(payload.store.state) || !this.isSupport(payload.controller.support)
    ) {
      throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
    }
    const controller = {support: payload.controller.support} as PersistentRciCapability['controller'];
    if (payload.controller.lastCheckedAt !== undefined) {
      if (typeof payload.controller.lastCheckedAt !== 'string') {
        throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
      }
      controller.lastCheckedAt = payload.controller.lastCheckedAt;
    }
    const extenders = payload.extenders.map((value) => this.parseExtender(value));
    const result: PersistentRciCapability = {
      store: {state: payload.store.state},
      controller,
      extenders,
      stale: payload.stale,
    };
    if (payload.lastEnumerationError !== undefined) {
      if (!this.isFailureCategory(payload.lastEnumerationError)) {
        throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
      }
      result.lastEnumerationError = payload.lastEnumerationError;
    }
    if (payload.lastEnumerationErrorAt !== undefined) {
      if (typeof payload.lastEnumerationErrorAt !== 'string') {
        throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
      }
      result.lastEnumerationErrorAt = payload.lastEnumerationErrorAt;
    }
    return result;
  }

  private parseExtender(value: unknown): PersistentRciCapability['extenders'][number] {
    if (
      !this.isRecord(value) || typeof value.identity !== 'string' || typeof value.name !== 'string'
      || typeof value.eligible !== 'boolean'
    ) {
      throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
    }
    if (!value.eligible) {
      if (
        !this.isEligibilityReason(value.reason) || value.state !== undefined || value.lastError !== undefined
        || value.lastHeartbeatAt !== undefined
      ) {
        throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
      }
      return {identity: value.identity, name: value.name, eligible: false, reason: value.reason};
    }
    if (
      value.reason !== undefined || (value.state !== undefined && !this.isSessionState(value.state))
      || (value.lastError !== undefined && !this.isFailureCategory(value.lastError))
      || (value.lastHeartbeatAt !== undefined && typeof value.lastHeartbeatAt !== 'string')
    ) {
      throw new PersistentRciSessionError('MALFORMED_RESPONSE', 200);
    }
    const result: PersistentRciCapability['extenders'][number] = {
      identity: value.identity,
      name: value.name,
      eligible: true,
    };
    if (value.state !== undefined) { result.state = value.state; }
    if (value.lastError !== undefined) { result.lastError = value.lastError; }
    if (value.lastHeartbeatAt !== undefined) { result.lastHeartbeatAt = value.lastHeartbeatAt; }
    return result;
  }

  private errorCode(payload: unknown): string | undefined {
    if (this.isRecord(payload) && this.isRecord(payload.error) && typeof payload.error.code === 'string') {
      return payload.error.code;
    }
    return undefined;
  }

  private controllerProbeFound(payload: unknown): boolean {
    return this.isRecord(payload) && this.isRecord(payload.probe) && payload.probe.found === true;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private isStoreState(value: unknown): value is PersistentStoreState {
    return typeof value === 'string' && (storeStates as readonly string[]).includes(value);
  }

  private isSupport(value: unknown): value is PersistentSupport {
    return typeof value === 'string' && (supports as readonly string[]).includes(value);
  }

  private isSessionState(value: unknown): value is PersistentSessionState {
    return typeof value === 'string' && (sessionStates as readonly string[]).includes(value);
  }

  private isEligibilityReason(value: unknown): value is PersistentEligibilityReason {
    return typeof value === 'string' && (eligibilityReasons as readonly string[]).includes(value);
  }

  private isFailureCategory(value: unknown): value is PersistentFailureCategory {
    return typeof value === 'string' && (persistentFailureCategories as readonly string[]).includes(value);
  }
}

export function createPersistentRciSessionService(): PersistentRciSessionService {
  return new PersistentRciSessionService();
}

export const persistentRciSessionService = createPersistentRciSessionService();
