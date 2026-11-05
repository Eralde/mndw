import {
  OPKG_INFO_URL,
  OPKG_INSTALL_URL,
  OPKG_LIST_URL,
  OPKG_REMOVE_URL,
  OPKG_UPDATE_URL,
  OPKG_UPGRADE_URL,
} from '../constants.js';
import {CSRF_HEADERS} from './csrf.js';
import {decodeErrorEnvelope, readErrorBody} from './error-envelope.js';
import {isRecord} from './json.js';

export interface PackageEntry {
  name: string;
  version: string;
  description: string;
  status: 'installed' | 'update_available' | 'available';
  newVersion?: string;
}

export interface PackageList {
  packages: PackageEntry[];
  metadataUpdatedAt: string | null;
}

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  size?: string;
  installedSize?: string;
  dependencies: string[];
  status: 'installed' | 'update_available' | 'available';
  installedTime?: string;
}

export class OpkgError extends Error {
  public readonly code: string;
  public readonly detail: unknown;

  constructor(message: string, code: string, detail?: unknown) {
    super(message);
    this.name = 'OpkgError';
    this.code = code;
    this.detail = detail;
  }
}

// DependencyConflictDetail is the structured payload the daemon attaches to a
// DEPENDENCY_CONFLICT error: the package whose removal was refused and the installed
// packages that depend on it. Lets the UI build a localized message.
export interface DependencyConflictDetail {
  package: string;
  dependents: string[];
}

export interface OpkgClient {
  list(): Promise<PackageList>;
  info(name: string): Promise<PackageInfo>;
  install(packages: string[]): Promise<{message: string; packages: string[]}>;
  remove(packages: string[]): Promise<{message: string; packages: string[]}>;
  upgrade(packages: string[]): Promise<{message: string; packages: string[]}>;
  update(): Promise<{message: string}>;
}

export function dependencyConflictDetail(error: OpkgError): DependencyConflictDetail | undefined {
  if (error.code !== 'DEPENDENCY_CONFLICT' || !isRecord(error.detail)) {
    return undefined;
  }

  const pkg = error.detail.package;
  const dependents = error.detail.dependents;

  if (typeof pkg !== 'string' || pkg.length === 0) {
    return undefined;
  }

  const validDependents = Array.isArray(dependents)
    && dependents.every((value): value is string => typeof value === 'string');

  return {package: pkg, dependents: validDependents ? dependents : []};
}

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
  const fields = decodeErrorEnvelope(await readErrorBody(response), response.statusText);

  return new OpkgError(fields.message, fields.code, fields.detail);
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
  const validStatus = status === 'installed' || status === 'update_available' || status === 'available';

  if (
    typeof name !== 'string' || name.length === 0 || typeof version !== 'string' || typeof description !== 'string'
    || !validStatus
  ) {
    throw malformedResponse();
  }

  if ((status === 'available' || status === 'update_available') && version.length === 0) {
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

function validateListResponse(body: unknown): PackageList {
  if (!isRecord(body) || !Array.isArray(body.packages)) {
    throw malformedResponse();
  }

  const metadataUpdatedAt = body.metadataUpdatedAt;

  if (metadataUpdatedAt !== null && typeof metadataUpdatedAt !== 'string') {
    throw malformedResponse();
  }

  if (typeof metadataUpdatedAt === 'string' && Number.isNaN(Date.parse(metadataUpdatedAt))) {
    throw malformedResponse();
  }

  return {packages: body.packages.map((entry) => validatePackageEntry(entry)), metadataUpdatedAt};
}

function validatePackageInfo(value: unknown): PackageInfo {
  if (!isRecord(value)) {
    throw malformedResponse();
  }

  const status = value.status;

  if (
    typeof value.name !== 'string' || value.name.length === 0 || typeof value.version !== 'string'
    || typeof value.description !== 'string' || !Array.isArray(value.dependencies)
    || !value.dependencies.every((dependency): dependency is string => typeof dependency === 'string')
    || (status !== 'installed' && status !== 'update_available' && status !== 'available')
  ) {
    throw malformedResponse();
  }

  const optionalStrings = ['size', 'installedSize', 'installedTime'] as const;

  for (const field of optionalStrings) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw malformedResponse();
    }
  }

  const size = typeof value.size === 'string' ? value.size : undefined;
  const installedSize = typeof value.installedSize === 'string' ? value.installedSize : undefined;
  const installedTime = typeof value.installedTime === 'string' ? value.installedTime : undefined;

  return {
    name: value.name,
    version: value.version,
    description: value.description,
    dependencies: value.dependencies,
    status,
    ...(size === undefined ? {} : {size}),
    ...(installedSize === undefined ? {} : {installedSize}),
    ...(installedTime === undefined ? {} : {installedTime}),
  };
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
      headers: {'Content-Type': 'application/json', ...CSRF_HEADERS},
      body: JSON.stringify({packages}),
    });

    return validateActionResponse(body);
  }

  return {
    async list(): Promise<PackageList> {
      const body = await request(OPKG_LIST_URL, {method: 'GET'});

      return validateListResponse(body);
    },

    async info(name: string): Promise<PackageInfo> {
      const params = new URLSearchParams({name});
      const body = await request(`${OPKG_INFO_URL}?${params.toString()}`, {method: 'GET'});

      return validatePackageInfo(body);
    },

    install: (packages) => postPackages(OPKG_INSTALL_URL, packages),
    remove: (packages) => postPackages(OPKG_REMOVE_URL, packages),
    upgrade: (packages) => postPackages(OPKG_UPGRADE_URL, packages),

    async update(): Promise<{message: string}> {
      const body = await request(OPKG_UPDATE_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...CSRF_HEADERS},
        body: '{}',
      });

      return validateUpdateResponse(body);
    },
  };
}

export const opkgClient: OpkgClient = createOpkgClient();
