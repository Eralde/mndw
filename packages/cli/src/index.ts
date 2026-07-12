#!/usr/bin/env tsx

import {Command} from 'commander';
import {resolve} from 'node:path';

import {ManifestValidationError} from '@mndw/sdk';

import {CliError} from './errors.js';
import {readManifest} from './manifest.js';
import {resolvePluginDir} from './paths.js';

export function createProgram(): Command {
  const program = new Command();

  program.name('mndw');
  program.command('validate <plugin-dir>').action((pluginDir: string) => {
    let result;

    try {
      result = readManifest(pluginDir);
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        throw new CliError(
          `Invalid manifest at ${resolve(resolvePluginDir(pluginDir), 'manifest.json')}: ${error.message}`,
        );
      }

      throw error;
    }

    process.stdout.write(`Validated ${result.manifest.name}: ${result.path}\n`);
  });

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    if (error instanceof CliError || error instanceof ManifestValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;

      return;
    }

    throw error;
  }
}

if (import.meta.main) {
  void run();
}
