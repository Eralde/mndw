#!/usr/bin/env tsx

import {Command, Option} from 'commander';
import {resolve} from 'node:path';

import {ManifestValidationError} from '@mndw/sdk-internal';

import {create} from './create.js';
import {runDev} from './dev.js';
import {CliError} from './errors.js';
import {validatePluginCatalogs} from './i18n-validator.js';
import {readManifest} from './manifest.js';
import {packPlugin} from './pack.js';
import {resolvePluginDir} from './paths.js';
import {runBuildBackendCommand} from './backend-build-run.js';
import {zipPlugin} from './zip.js';

interface CreateCommandOptions {
  readonly type?: string;
  readonly framework?: string;
  readonly out?: string;
  readonly route?: string;
  readonly label?: string;
  readonly backend?: string;
  readonly install?: boolean;
}

interface DevCommandOptions {
  readonly daemon?: string;
  readonly port?: number;
  readonly addr?: string;
  readonly hostDevice?: string;
  readonly uiPort?: number;
  readonly prebuiltHost?: boolean;
}

interface ValidateCommandOptions {
  readonly strict?: boolean;
}

/** Rewrites an SDK manifest-validation failure into a CLI error naming the offending manifest path. */
function rethrowManifestError(pluginDir: string, error: unknown): never {
  if (error instanceof ManifestValidationError) {
    throw new CliError(
      `Invalid manifest at ${resolve(resolvePluginDir(pluginDir), 'manifest.json')}: ${error.message}`,
    );
  }

  throw error;
}

export function createProgram(): Command {
  const program = new Command();

  program.name('mndw');

  program
    .command('create <name>')
    .option('--type <type>', 'plugin type: widget|page', 'widget')
    .option('--framework <framework>', 'UI framework: vanilla|svelte|vue|angular')
    .option('--out <dir>', 'output directory (default: ./<name>)')
    .option('--route <route>', 'page route (page type only; default /<name>)')
    .option('--label <label>', 'human-readable label (default derived from name)')
    .option('--backend <runtime>', 'include a backend starter ("sh" or "go")')
    .option('--no-install', 'skip dependency installation')
    .action(async (name: string, options: CreateCommandOptions) => {
      const outDir = resolve(process.cwd(), options.out ?? name);
      const result = await create({
        name,
        outDir,
        type: options.type as 'widget' | 'page' | undefined,
        framework: options.framework as 'vanilla' | 'svelte' | 'vue' | 'angular' | undefined,
        route: options.route,
        label: options.label,
        backend: options.backend as 'sh' | 'go' | undefined,
        noInstall: options.install === false,
      });

      process.stdout.write(
        `Created ${result.plan.type} plugin ${result.plan.name} (${result.plan.framework}) → ${result.outDir}\n`,
      );
    });

  program
    .command('dev <plugin-dir>')
    .description('run a local daemon + host that load the plugin from source with HMR')
    .option('--daemon <binary>', 'path to a prebuilt mndwd binary (required outside a source checkout)')
    .option('--port <port>', 'local daemon port (default 9090)', (value) => Number.parseInt(value, 10))
    .option('--addr <device>', 'Keenetic device IP, host[:port], or http(s) URL')
    .addOption(new Option('--host-device <url>', 'compatibility alias for --addr').hideHelp())
    .option('--ui-port <port>', 'local UI dev-server port', (value) => Number.parseInt(value, 10), 5173)
    .addOption(new Option('--prebuilt-host', 'use the packaged dev host').hideHelp())
    .action(async (pluginDir: string, options: DevCommandOptions) => {
      if (options.addr !== undefined && options.hostDevice !== undefined && options.addr !== options.hostDevice) {
        throw new CliError('--addr and --host-device cannot be used with different values');
      }

      await runDev(pluginDir, {
        daemonBinary: options.daemon,
        port: options.port,
        addr: options.addr ?? options.hostDevice,
        uiPort: options.uiPort,
        prebuiltHost: options.prebuiltHost,
      });
    });

  program
    .command('validate <plugin-dir>')
    .option('--strict', 'treat catalog key-parity warnings as errors')
    .action((pluginDir: string, options: ValidateCommandOptions) => {
      let result;

      try {
        result = readManifest(pluginDir);
      } catch (error) {
        rethrowManifestError(pluginDir, error);
      }

      const warnings = [
        ...result.warnings,
        ...validatePluginCatalogs(resolvePluginDir(pluginDir), result.manifest, {
          strict: options.strict === true,
        }),
      ];

      for (const warning of warnings) {
        process.stdout.write(`Warning: ${warning}\n`);
      }

      process.stdout.write(`Validated ${result.manifest.name}: ${result.path}\n`);
    });

  program
    .command('pack <plugin-dir>')
    .option('--out-dir <dir>', 'output directory (default: <plugin-dir>/dist)')
    .option('--dev', 'pack the development entry instead of the configured production entry')
    .option('--skip-backend-build', 'skip package backend build hook for an already-built dev artifact')
    .action(async (pluginDir: string, options: {outDir?: string; dev?: boolean; skipBackendBuild?: boolean}) => {
      let result;

      try {
        result = await packPlugin(pluginDir, {
          outDir: options.outDir,
          development: options.dev,
          skipBackendBuild: options.skipBackendBuild,
        });
      } catch (error) {
        rethrowManifestError(pluginDir, error);
      }

      for (const warning of result.warnings) {
        process.stdout.write(`Warning: ${warning}\n`);
      }

      process.stdout.write(`Packed ${result.manifest.name} (${result.framework}) → ${result.outDir}\n`);
    });

  program
    .command('zip <plugin-dir>')
    .option('--out-dir <dir>', 'pack output directory (default: <plugin-dir>/dist)')
    .option('--output <file>', 'archive destination (default: <plugin-dir>/<plugin-name>.zip)')
    .action(async (pluginDir: string, options: {outDir?: string; output?: string}) => {
      let result;

      try {
        result = await zipPlugin(pluginDir, {outDir: options.outDir, output: options.output});
      } catch (error) {
        rethrowManifestError(pluginDir, error);
      }

      process.stdout.write(`Zipped ${result.pack.manifest.name} → ${result.outputPath}\n`);
    });

  program
    .command('build-backend')
    .description(
      'build the current plugin\'s Go backend (name from manifest.json, binary/entry from package.json mndw.backend)',
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_options: unknown, command: Command) => {
      runBuildBackendCommand({pluginDir: process.cwd(), args: command.args});
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
