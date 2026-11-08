import {
  SELF_UPDATE_APPLY_URL,
  SELF_UPDATE_CHECK_URL,
  SELF_UPDATE_REVERT_URL,
  SELF_UPDATE_STATUS_URL,
} from '../constants.js';
import {isNonEmptyString, isRecord} from './json.js';
import {HostApiError, createRestClient, malformedApiResponse} from './rest.js';

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

export class SelfUpdateError extends HostApiError {
  constructor(message: string, code: string, status?: number, detail?: unknown) {
    super(message, code, detail, status);
    this.name = 'SelfUpdateError';
  }
}

const makeSelfUpdateError = (message: string, code: string, detail?: unknown, status?: number): SelfUpdateError => {
  return new SelfUpdateError(message, code, status, detail);
};

const isOperation = (value: unknown): value is 'update' | 'revert' => value === 'update' || value === 'revert';

function validateStatus(body: unknown): SelfUpdateStatus {
  if (!isRecord(body) || (body.state !== 'idle' && body.state !== 'in-progress' && body.state !== 'failed')) {
    throw malformedApiResponse(makeSelfUpdateError);
  }

  if (!isNonEmptyString(body.version)) {
    throw malformedApiResponse(makeSelfUpdateError);
  }

  if (body.operation !== undefined && !isOperation(body.operation)) {
    throw malformedApiResponse(makeSelfUpdateError);
  }

  for (const field of ['targetVersion', 'failureCode', 'rollbackVersion'] as const) {
    if (body[field] !== undefined && !isNonEmptyString(body[field])) {
      throw malformedApiResponse(makeSelfUpdateError);
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
    throw malformedApiResponse(makeSelfUpdateError);
  }

  if (body.targetVersion !== undefined && !isNonEmptyString(body.targetVersion)) {
    throw malformedApiResponse(makeSelfUpdateError);
  }

  if (body.rollbackVersion !== undefined && !isNonEmptyString(body.rollbackVersion)) {
    throw malformedApiResponse(makeSelfUpdateError);
  }

  if (body.updateAvailable !== (body.targetVersion !== undefined)) {
    throw malformedApiResponse(makeSelfUpdateError);
  }

  if (body.rollbackAvailable !== (body.rollbackVersion !== undefined)) {
    throw malformedApiResponse(makeSelfUpdateError);
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
    throw malformedApiResponse(makeSelfUpdateError);
  }

  return {operation: body.operation, targetVersion: body.targetVersion};
}

export function createSelfUpdateClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): SelfUpdateClient {
  const rest = createRestClient(fetchImpl, makeSelfUpdateError);

  async function post(url: string): Promise<unknown> {
    return rest.request(url, {method: 'POST', json: {}});
  }

  return {
    async status(): Promise<SelfUpdateStatus> {
      return validateStatus(await rest.request(SELF_UPDATE_STATUS_URL, {method: 'GET'}));
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
