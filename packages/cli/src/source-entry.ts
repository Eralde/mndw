import {statSync} from 'node:fs';
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path';

import {CliError} from './errors.js';
import {readPluginPackage} from './plugin-package.js';

const DEFAULT_SOURCE_ENTRY = 'src/index.ts';

function validateSourceEntry(pluginDir: string, sourceEntry: string): string {
  const normalized = sourceEntry.replaceAll('\\', '/');

  if (normalized !== sourceEntry || isAbsolute(sourceEntry) || !normalized.startsWith('src/')) {
    throw new CliError(`Invalid production entry path: ${sourceEntry}`);
  }

  const sourcePath = resolve(pluginDir, sourceEntry);
  const sourceRelative = relative(pluginDir, sourcePath)
    .split(sep)
    .join('/');

  if (sourceRelative !== sourceEntry || !sourceRelative.startsWith('src/')) {
    throw new CliError(`Invalid production entry path: ${sourceEntry}`);
  }

  if (extname(sourceEntry) !== '.ts') {
    throw new CliError(`Production entry must be a TypeScript file: ${sourceEntry}`);
  }

  try {
    if (!statSync(sourcePath).isFile()) {
      throw new CliError(`Production entry is not a regular file: ${sourcePath}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      const code = (error as NodeJS.ErrnoException).code;
      const message = code === 'ENOENT'
        ? `Missing production entry at ${sourcePath}`
        : `Failed to inspect production entry at ${sourcePath}: ${error.message}`;

      throw new CliError(message);
    }

    throw error;
  }

  return sourceEntry;
}

/** Resolves and validates the TypeScript source entry used by mndw pack. */
export function resolveProductionSourceEntry(pluginDir: string): string {
  const packageMetadata = readPluginPackage(pluginDir);
  const mndw = packageMetadata?.mndw;

  if (mndw === undefined) {
    return validateSourceEntry(pluginDir, DEFAULT_SOURCE_ENTRY);
  }

  if (typeof mndw !== 'object' || mndw === null || Array.isArray(mndw)) {
    throw new CliError(`Plugin package mndw configuration at ${join(pluginDir, 'package.json')} must be an object`);
  }

  const configured = mndw.productionEntry;

  if (configured === undefined) {
    return validateSourceEntry(pluginDir, DEFAULT_SOURCE_ENTRY);
  }

  if (typeof configured !== 'string' || configured.length === 0) {
    throw new CliError(
      `Plugin package productionEntry at ${join(pluginDir, 'package.json')} must be a non-empty string`,
    );
  }

  return validateSourceEntry(pluginDir, configured);
}

/** Resolves and validates the development source entry used by repository dev builds. */
export function resolveDevelopmentSourceEntry(pluginDir: string): string {
  return validateSourceEntry(pluginDir, DEFAULT_SOURCE_ENTRY);
}
