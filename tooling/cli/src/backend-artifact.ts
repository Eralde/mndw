import {isAbsolute} from 'node:path';

import {type ProductTarget, isProductTarget} from './go-target.js';

export interface BackendArtifact {
  readonly source: string;
  readonly destination: string;
}

export interface BackendBuildResult {
  readonly plugin: string;
  readonly target: ProductTarget;
  readonly binaries: readonly BackendArtifact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !isAbsolute(value)
    && !value.startsWith('\\')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

function invalid(field: string): never {
  throw new Error(`invalid backend artifact field ${field}`);
}

export function parseBackendArtifact(value: unknown): BackendBuildResult {
  if (!isRecord(value)) {
    invalid('artifact');
  }

  if (typeof value.plugin !== 'string') {
    invalid('plugin');
  }

  if (typeof value.target !== 'string' || !isProductTarget(value.target)) {
    invalid('target');
  }

  if (!Array.isArray(value.binaries)) {
    invalid('binaries');
  }

  const destinations = new Set<string>();
  const binaries: BackendArtifact[] = [];

  for (const [index, binary] of value.binaries.entries()) {
    if (!isRecord(binary)) {
      invalid(`binaries[${index}]`);
    }

    if (!isSafeRelativePath(binary.source)) {
      invalid(`binaries[${index}].source`);
    }

    if (!isSafeRelativePath(binary.destination)) {
      invalid(`binaries[${index}].destination`);
    }

    if (destinations.has(binary.destination)) {
      invalid(`binaries[${index}].destination`);
    }

    destinations.add(binary.destination);
    binaries.push({source: binary.source, destination: binary.destination});
  }

  const artifact: BackendBuildResult = {
    plugin: value.plugin,
    target: value.target,
    binaries,
  };

  return artifact;
}
