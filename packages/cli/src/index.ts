#!/usr/bin/env tsx

import {Command} from 'commander';
import {resolve} from 'node:path';

import {ManifestValidationError} from '@mndw/sdk';

import {createPlugin} from './create.js';
import {runDev} from './dev.js';
import {CliError} from './errors.js';
import {readManifest} from './manifest.js';
import {packExamplePlugins, packPlugin} from './pack.js';
import {resolvePluginDir} from './paths.js';
import {zipPlugin} from './zip.js';

interface CreateCommandOptions {
  readonly type?: string;
  readonly framework?: string;
  readonly out?: string;
  readonly route?: string;
  readonly label?: string;
  readonly backend?: string;
}

interface DevCommandOptions {
  readonly daemon?: string;
  readonly port?: number;
  readonly hostDevice?: string;
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
    .option('--framework <framework>', 'UI framework: vanilla|svelte|vue|angular', 'vanilla')
    .option('--out <dir>', 'output directory (default: ./<name>)')
    .option('--route <route>', 'page route (page type only; default /<name>)')
    .option('--label <label>', 'human-readable label (default derived from name)')
    .option('--backend <runtime>', 'include a backend starter (only "sh")')
    .action((name: string, options: CreateCommandOptions) => {
      const outDir = resolve(process.cwd(), options.out ?? name);
      const result = createPlugin({
        name,
        outDir,
        type: options.type as 'widget' | 'page' | undefined,
        framework: options.framework as 'vanilla' | 'svelte' | 'vue' | 'angular' | undefined,
        route: options.route,
        label: options.label,
        backend: options.backend as 'sh' | undefined,
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
    .option('--host-device <url>', 'Keenetic device URL to proxy /rci and /auth to')
    .action(async (pluginDir: string, options: DevCommandOptions) => {
      await runDev(pluginDir, {
        daemonBinary: options.daemon,
        port: options.port,
        hostDevice: options.hostDevice,
      });
    });

  program.command('validate <plugin-dir>').action((pluginDir: string) => {
    let result;

    try {
      result = readManifest(pluginDir);
    } catch (error) {
      rethrowManifestError(pluginDir, error);
    }

    process.stdout.write(`Validated ${result.manifest.name}: ${result.path}\n`);
  });

  program
    .command('pack <plugin-dir>')
    .option('--out-dir <dir>', 'output directory (default: <plugin-dir>/dist)')
    .action(async (pluginDir: string, options: {outDir?: string}) => {
      let result;

      try {
        result = await packPlugin(pluginDir, {outDir: options.outDir});
      } catch (error) {
        rethrowManifestError(pluginDir, error);
      }

      process.stdout.write(`Packed ${result.manifest.name} (${result.framework}) → ${result.outDir}\n`);
    });

  program
    .command('pack-examples [source-dir]')
    .description('pack every manifest-backed plugin source directory into one destination')
    .requiredOption('--out-dir <dir>', 'directory containing one output subdirectory per plugin')
    .action(async (sourceDir: string | undefined, options: {outDir: string}) => {
      const names = await packExamplePlugins({sourceDir, outDir: options.outDir});

      process.stdout.write(`Packed ${names.length} example plugins: ${names.join(', ')}\n`);
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
