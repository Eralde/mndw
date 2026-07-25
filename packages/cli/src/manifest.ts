import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';

import {type PluginManifestOutput, validateManifest} from '@mndw/sdk';

import {CliError} from './errors.js';
import {resolvePluginDir} from './paths.js';
import {resolveProductionSourceEntry} from './source-entry.js';

export interface LoadedManifest {
  readonly manifest: PluginManifestOutput;
  readonly path: string;
}

export function readManifest(pluginDir: string): LoadedManifest {
  const resolvedPluginDir = resolvePluginDir(pluginDir);
  const path = resolve(resolvedPluginDir, 'manifest.json');
  let contents: string;

  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      throw new CliError(`Failed to read manifest at ${path}: ${error.message}`);
    }

    throw error;
  }

  let manifest: PluginManifestOutput;

  try {
    manifest = validateManifest(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError(`Failed to parse manifest at ${path}: ${error.message}`);
    }

    throw error;
  }

  const sourceEntryPath = resolve(resolvedPluginDir, 'src/index.ts');

  try {
    if (!statSync(sourceEntryPath).isFile()) {
      throw new CliError(`Source entry is not a regular file: ${sourceEntryPath}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      const code = (error as NodeJS.ErrnoException).code;
      const message = code === 'ENOENT'
        ? `Missing source entry at ${sourceEntryPath}`
        : `Failed to inspect source entry at ${sourceEntryPath}: ${error.message}`;

      throw new CliError(message);
    }

    throw error;
  }

  resolveProductionSourceEntry(resolvedPluginDir);

  return {manifest, path};
}
