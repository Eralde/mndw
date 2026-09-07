import {type ProductTarget, isProductTarget} from './go-target.js';

export interface PackedBackendMetadata {
  readonly target: ProductTarget;
  readonly files: readonly {readonly path: string; readonly sha256: string}[];
}

export interface PackedPluginArtifact {
  readonly schemaVersion: 1;
  readonly plugin: string;
  readonly entry: string;
  readonly staticBackends: readonly string[];
  readonly backend?: PackedBackendMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string): never {
  throw new Error(`invalid packed plugin artifact field ${field}`);
}

function parsePackedBackendMetadata(value: unknown): PackedBackendMetadata {
  if (!isRecord(value)) {
    invalid('backend');
  }

  if (typeof value.target !== 'string' || !isProductTarget(value.target)) {
    invalid('backend.target');
  }

  if (!Array.isArray(value.files)) {
    invalid('backend.files');
  }

  const files: {path: string; sha256: string}[] = [];

  for (const [index, file] of value.files.entries()) {
    if (!isRecord(file)) {
      invalid(`backend.files[${index}]`);
    }

    if (
      typeof file.path !== 'string'
      || file.path.length === 0
      || file.path.startsWith('/')
      || file.path.split('/').includes('..')
    ) {
      invalid(`backend.files[${index}].path`);
    }

    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      invalid(`backend.files[${index}].sha256`);
    }

    files.push({path: file.path, sha256: file.sha256});
  }

  return {target: value.target, files};
}

export function parsePackedPluginArtifact(value: unknown): PackedPluginArtifact {
  if (!isRecord(value)) {
    invalid('artifact');
  }

  if (value.schemaVersion !== 1) {
    invalid('schemaVersion');
  }

  if (typeof value.plugin !== 'string') {
    invalid('plugin');
  }

  if (typeof value.entry !== 'string') {
    invalid('entry');
  }

  if (!Array.isArray(value.staticBackends)) {
    invalid('staticBackends');
  }

  const staticBackends: string[] = [];

  for (const [index, path] of value.staticBackends.entries()) {
    if (typeof path !== 'string') {
      invalid(`staticBackends[${index}]`);
    }

    staticBackends.push(path);
  }

  const backend = value.backend === undefined ? undefined : parsePackedBackendMetadata(value.backend);

  const artifact: PackedPluginArtifact = {
    schemaVersion: 1,
    plugin: value.plugin,
    entry: value.entry,
    staticBackends,
    ...(backend === undefined ? {} : {backend}),
  };

  return artifact;
}
