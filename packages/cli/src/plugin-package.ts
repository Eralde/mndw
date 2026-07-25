import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {CliError} from './errors.js';

export interface PluginPackage {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly mndw?: {
    readonly productionEntry?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

  return parsed as PluginPackage;
}
