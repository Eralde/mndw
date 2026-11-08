import {
  OPKG_INFO_URL,
  OPKG_INSTALL_URL,
  OPKG_LIST_URL,
  OPKG_REMOVE_URL,
  OPKG_UPDATE_URL,
  OPKG_UPGRADE_URL,
} from '../constants.js';
import {isRecord} from './json.js';
import {HostApiError, createRestClient, malformedApiResponse} from './rest.js';

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

export class OpkgError extends HostApiError {
  constructor(message: string, code: string, detail?: unknown, status?: number) {
    super(message, code, detail, status);
    this.name = 'OpkgError';
  }
}

const makeOpkgError = (message: string, code: string, detail?: unknown, status?: number): OpkgError => {
  return new OpkgError(message, code, detail, status);
};

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

function validatePackageEntry(value: unknown): PackageEntry {
  if (!isRecord(value)) {
    throw malformedApiResponse(makeOpkgError);
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
    throw malformedApiResponse(makeOpkgError);
  }

  if ((status === 'available' || status === 'update_available') && version.length === 0) {
    throw malformedApiResponse(makeOpkgError);
  }

  if (status === 'update_available') {
    if (typeof newVersion !== 'string' || newVersion.length === 0) {
      throw malformedApiResponse(makeOpkgError);
    }
  } else if (newVersion !== undefined) {
    throw malformedApiResponse(makeOpkgError);
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
    throw malformedApiResponse(makeOpkgError);
  }

  const metadataUpdatedAt = body.metadataUpdatedAt;

  if (metadataUpdatedAt !== null && typeof metadataUpdatedAt !== 'string') {
    throw malformedApiResponse(makeOpkgError);
  }

  if (typeof metadataUpdatedAt === 'string' && Number.isNaN(Date.parse(metadataUpdatedAt))) {
    throw malformedApiResponse(makeOpkgError);
  }

  return {packages: body.packages.map((entry) => validatePackageEntry(entry)), metadataUpdatedAt};
}

function validatePackageInfo(value: unknown): PackageInfo {
  if (!isRecord(value)) {
    throw malformedApiResponse(makeOpkgError);
  }

  const status = value.status;

  if (
    typeof value.name !== 'string' || value.name.length === 0 || typeof value.version !== 'string'
    || typeof value.description !== 'string' || !Array.isArray(value.dependencies)
    || !value.dependencies.every((dependency): dependency is string => typeof dependency === 'string')
    || (status !== 'installed' && status !== 'update_available' && status !== 'available')
  ) {
    throw malformedApiResponse(makeOpkgError);
  }

  const optionalStrings = ['size', 'installedSize', 'installedTime'] as const;

  for (const field of optionalStrings) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw malformedApiResponse(makeOpkgError);
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
    throw malformedApiResponse(makeOpkgError);
  }

  if (!body.packages.every((value): value is string => typeof value === 'string')) {
    throw malformedApiResponse(makeOpkgError);
  }

  return {message: body.message, packages: body.packages};
}

function validateUpdateResponse(body: unknown): {message: string} {
  if (!isRecord(body) || body.ok !== true || typeof body.message !== 'string') {
    throw malformedApiResponse(makeOpkgError);
  }

  return {message: body.message};
}

export function createOpkgClient(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpkgClient {
  const rest = createRestClient(fetchImpl, makeOpkgError);

  async function postPackages(url: string, packages: string[]): Promise<{message: string; packages: string[]}> {
    const body = await rest.request(url, {
      method: 'POST',
      json: {packages},
    });

    return validateActionResponse(body);
  }

  return {
    async list(): Promise<PackageList> {
      const body = await rest.request(OPKG_LIST_URL, {method: 'GET'});

      return validateListResponse(body);
    },

    async info(name: string): Promise<PackageInfo> {
      const params = new URLSearchParams({name});
      const body = await rest.request(`${OPKG_INFO_URL}?${params.toString()}`, {method: 'GET'});

      return validatePackageInfo(body);
    },

    install: (packages) => postPackages(OPKG_INSTALL_URL, packages),
    remove: (packages) => postPackages(OPKG_REMOVE_URL, packages),
    upgrade: (packages) => postPackages(OPKG_UPGRADE_URL, packages),

    async update(): Promise<{message: string}> {
      const body = await rest.request(OPKG_UPDATE_URL, {
        method: 'POST',
        json: {},
      });

      return validateUpdateResponse(body);
    },
  };
}

export const opkgClient: OpkgClient = createOpkgClient();
