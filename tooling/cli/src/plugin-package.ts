import {readFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

import {CliError} from './errors.js';

export interface PluginPackage {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly mndw?: {
    readonly productionEntry?: unknown;
    readonly backendBuildScript?: unknown;
    readonly backendAssets?: readonly string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || isAbsolute(value) || value.startsWith('/') || value.startsWith('\\')) {
    return false;
  }

  return !value.split(/[\\/]/u).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function validateBackendAssets(packagePath: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CliError(`Plugin package mndw.backendAssets at ${packagePath} must be a non-empty array`);
  }

  const seen = new Set<string>();

  for (const asset of value) {
    if (typeof asset !== 'string' || !isSafeRelativePath(asset)) {
      throw new CliError(`Plugin package mndw.backendAssets at ${packagePath} must contain safe relative paths`);
    }

    if (seen.has(asset)) {
      throw new CliError(`Plugin package mndw.backendAssets at ${packagePath} contains duplicate path: ${asset}`);
    }

    seen.add(asset);
  }
}

/** Reads optional plugin package metadata with one consistent CLI error contract. */
export function readPluginPackage(pluginDir: string): PluginPackage | null {
  const packagePath = join(pluginDir, 'package.json');
  let contents: string;

  try {
    contents = readFileSync(packagePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    if (error instanceof Error) {
      throw new CliError(`Failed to read plugin package at ${packagePath}: ${error.message}`);
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`Failed to parse plugin package at ${packagePath}: ${error.message}`);
    }

    throw error;
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new CliError(`Plugin package at ${packagePath} must contain a JSON object`);
  }

  if (isRecord(parsed.mndw) && parsed.mndw.backendAssets !== undefined) {
    validateBackendAssets(packagePath, parsed.mndw.backendAssets);
  }

  return parsed as PluginPackage;
}
