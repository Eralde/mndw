import {OPKG_INSTALL_URL, OPKG_LIST_URL, OPKG_REMOVE_URL, OPKG_UPDATE_URL, OPKG_UPGRADE_URL} from '../constants.js';

export interface PackageEntry {
  name: string;
  version: string;
  description: string;
  status: 'installed' | 'update_available' | 'uninstalled';
  newVersion?: string;
}

export class OpkgError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'OpkgError';
    this.code = code;
  }
}

export interface OpkgClient {
  list(): Promise<PackageEntry[]>;
  install(packages: string[]): Promise<{message: string; packages: string[]}>;
  remove(packages: string[]): Promise<{message: string; packages: string[]}>;
  upgrade(packages: string[]): Promise<{message: string; packages: string[]}>;
  update(): Promise<{message: string}>;
}

interface ErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

function malformedResponse(): OpkgError {
  return new OpkgError('Malformed response', 'UNKNOWN');
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw malformedResponse();
  }
}

async function errorFromResponse(response: Response): Promise<OpkgError> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return new OpkgError(response.statusText, 'UNKNOWN');
  }

  const envelope = isRecord(body) ? body as ErrorEnvelope : undefined;
  const error = envelope?.error;
  const message = typeof error?.message === 'string' ? error.message : response.statusText;
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';

  return new OpkgError(message, code);
}

function validatePackageEntry(value: unknown): PackageEntry {
  if (!isRecord(value)) {
    throw malformedResponse();
  }

  const name = value.name;
  const version = value.version;
  const description = value.description;
  const status = value.status;
  const newVersion = value.newVersion;
  const validStatus = status === 'installed' || status === 'update_available' || status === 'uninstalled';

  if (
    typeof name !== 'string' || name.length === 0 || typeof version !== 'string' || typeof description !== 'string'
    || !validStatus
  ) {
    throw malformedResponse();
  }

  if ((status === 'uninstalled' || status === 'update_available') && version.length === 0) {
    throw malformedResponse();
  }

  if (status === 'update_available') {
    if (typeof newVersion !== 'string' || newVersion.length === 0) {
      throw malformedResponse();
    }
  } else if (newVersion !== undefined) {
    throw malformedResponse();
  }

  return {
    name,
    version,
    description,
    status,
    ...(newVersion === undefined ? {} : {newVersion}),
  };
}

function validateListResponse(body: unknown): PackageEntry[] {
  if (!isRecord(body) || !Array.isArray(body.packages)) {
    throw malformedResponse();
  }

  return body.packages.map((entry) => validatePackageEntry(entry));
}

function validateActionResponse(body: unknown): {message: string; packages: string[]} {
  if (!isRecord(body) || body.ok !== true || typeof body.message !== 'string' || !Array.isArray(body.packages)) {
    throw malformedResponse();
  }

  if (!body.packages.every((value): value is string => typeof value === 'string')) {
    throw malformedResponse();
  }

  return {message: body.message, packages: body.packages};
}

function validateUpdateResponse(body: unknown): {message: string} {
  if (!isRecord(body) || body.ok !== true || typeof body.message !== 'string') {
    throw malformedResponse();
  }

  return {message: body.message};
}

export function createOpkgClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpkgClient {
  async function request(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, init);

    if (!response.ok) {
      throw await errorFromResponse(response);
    }

    return parseJson(response);
  }

  async function postPackages(url: string, packages: string[]): Promise<{message: string; packages: string[]}> {
    const body = await request(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({packages}),
    });

    return validateActionResponse(body);
  }

  return {
    async list(): Promise<PackageEntry[]> {
      const body = await request(OPKG_LIST_URL, {method: 'GET'});

      return validateListResponse(body);
    },

    install: (packages) => postPackages(OPKG_INSTALL_URL, packages),
    remove: (packages) => postPackages(OPKG_REMOVE_URL, packages),
    upgrade: (packages) => postPackages(OPKG_UPGRADE_URL, packages),

    async update(): Promise<{message: string}> {
      const body = await request(OPKG_UPDATE_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{}',
      });

      return validateUpdateResponse(body);
    },
  };
}

export const opkgClient: OpkgClient = createOpkgClient();
