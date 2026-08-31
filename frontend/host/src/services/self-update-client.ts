import {
  SELF_UPDATE_APPLY_URL,
  SELF_UPDATE_CHECK_URL,
  SELF_UPDATE_REVERT_URL,
  SELF_UPDATE_STATUS_URL,
} from '../constants.js';

export interface SelfUpdateStatus {
  state: 'idle' | 'in-progress' | 'failed';
  operation?: 'update' | 'revert';
  version: string;
  targetVersion?: string;
  failureCode?: string;
  rollbackVersion?: string;
}

export interface SelfUpdateCheck {
  currentVersion: string;
  targetVersion?: string;
  updateAvailable: boolean;
  rollbackVersion?: string;
  rollbackAvailable: boolean;
}

export interface SelfUpdateAccepted {
  operation: 'update' | 'revert';
  targetVersion: string;
}

export interface SelfUpdateClient {
  status(): Promise<SelfUpdateStatus>;
  check(): Promise<SelfUpdateCheck>;
  apply(): Promise<SelfUpdateAccepted>;
  revert(): Promise<SelfUpdateAccepted>;
}

export class SelfUpdateError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SelfUpdateError';
    this.code = code;
  }
}

interface ErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isOperation = (value: unknown): value is 'update' | 'revert' => value === 'update' || value === 'revert';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const malformedResponse = (): SelfUpdateError => new SelfUpdateError('Malformed response', 'UNKNOWN');

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw malformedResponse();
  }
}

async function errorFromResponse(response: Response): Promise<SelfUpdateError> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return new SelfUpdateError(response.statusText, 'UNKNOWN');
  }

  const envelope = isRecord(body) ? body as ErrorEnvelope : undefined;
  const error = envelope?.error;
  const message = typeof error?.message === 'string' ? error.message : response.statusText;
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';

  return new SelfUpdateError(message, code);
}

function validateStatus(body: unknown): SelfUpdateStatus {
  if (!isRecord(body) || (body.state !== 'idle' && body.state !== 'in-progress' && body.state !== 'failed')) {
    throw malformedResponse();
  }

  if (!isNonEmptyString(body.version)) {
    throw malformedResponse();
  }

  if (body.operation !== undefined && !isOperation(body.operation)) {
    throw malformedResponse();
  }

  for (const field of ['targetVersion', 'failureCode', 'rollbackVersion'] as const) {
    if (body[field] !== undefined && !isNonEmptyString(body[field])) {
      throw malformedResponse();
    }
  }

  const targetVersion = body.targetVersion === undefined ? undefined : body.targetVersion as string;
  const failureCode = body.failureCode === undefined ? undefined : body.failureCode as string;
  const rollbackVersion = body.rollbackVersion === undefined ? undefined : body.rollbackVersion as string;

  return {
    state: body.state,
    version: body.version,
    ...(body.operation === undefined ? {} : {operation: body.operation}),
    ...(targetVersion === undefined ? {} : {targetVersion}),
    ...(failureCode === undefined ? {} : {failureCode}),
    ...(rollbackVersion === undefined ? {} : {rollbackVersion}),
  };
}

function validateCheck(body: unknown): SelfUpdateCheck {
  if (
    !isRecord(body)
    || !isNonEmptyString(body.currentVersion)
    || typeof body.updateAvailable !== 'boolean'
    || typeof body.rollbackAvailable !== 'boolean'
  ) {
    throw malformedResponse();
  }

  if (body.targetVersion !== undefined && !isNonEmptyString(body.targetVersion)) {
    throw malformedResponse();
  }

  if (body.rollbackVersion !== undefined && !isNonEmptyString(body.rollbackVersion)) {
    throw malformedResponse();
  }

  if (body.updateAvailable !== (body.targetVersion !== undefined)) {
    throw malformedResponse();
  }

  if (body.rollbackAvailable !== (body.rollbackVersion !== undefined)) {
    throw malformedResponse();
  }

  const targetVersion = body.targetVersion === undefined ? undefined : body.targetVersion;
  const rollbackVersion = body.rollbackVersion === undefined ? undefined : body.rollbackVersion;

  return {
    currentVersion: body.currentVersion,
    updateAvailable: body.updateAvailable,
    rollbackAvailable: body.rollbackAvailable,
    ...(targetVersion === undefined ? {} : {targetVersion}),
    ...(rollbackVersion === undefined ? {} : {rollbackVersion}),
  };
}

function validateAccepted(body: unknown): SelfUpdateAccepted {
  if (!isRecord(body) || !isOperation(body.operation) || !isNonEmptyString(body.targetVersion)) {
    throw malformedResponse();
  }

  return {operation: body.operation, targetVersion: body.targetVersion};
}

const csrfHeaders = (): Headers =>
  new Headers({
    'Content-Type': 'application/json',
    'X-Mndw-Csrf': '1',
  });

export function createSelfUpdateClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): SelfUpdateClient {
  async function request(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, init);

    if (!response.ok) {
      throw await errorFromResponse(response);
    }

    return parseJson(response);
  }

  async function post(url: string): Promise<unknown> {
    return request(url, {method: 'POST', headers: csrfHeaders(), body: '{}'});
  }

  return {
    async status(): Promise<SelfUpdateStatus> {
      return validateStatus(await request(SELF_UPDATE_STATUS_URL, {method: 'GET'}));
    },

    async check(): Promise<SelfUpdateCheck> {
      return validateCheck(await post(SELF_UPDATE_CHECK_URL));
    },

    async apply(): Promise<SelfUpdateAccepted> {
      return validateAccepted(await post(SELF_UPDATE_APPLY_URL));
    },

    async revert(): Promise<SelfUpdateAccepted> {
      return validateAccepted(await post(SELF_UPDATE_REVERT_URL));
    },
  };
}

export const selfUpdateClient: SelfUpdateClient = createSelfUpdateClient();
