import {type SpawnSyncOptions} from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';

import {type BackendBuildResult, parseBackendArtifact} from './backend-artifact.js';
import {CliError} from './errors.js';
import {type ProductTarget, isProductTarget} from './go-target.js';

export type {BackendArtifact, BackendBuildResult} from './backend-artifact.js';

export interface BackendBuildOptions {
  readonly pluginDir: string;
  readonly plugin: string;
  readonly target: string;
  readonly outDir: string;
  readonly spawn?: BackendSpawn;
}

export interface BackendSpawnResult {
  readonly error?: Error;
  readonly status: number | null;
}

export type BackendSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => BackendSpawnResult;

interface PluginPackage {
  readonly scripts?: Record<string, unknown>;
  readonly mndw?: {readonly backendBuildScript?: unknown};
}

function readBackendArtifact(outDir: string, plugin: string, target: ProductTarget): BackendBuildResult {
  const artifactPath = resolve(outDir, 'backend-artifact.json');

  if (!existsSync(artifactPath)) {
    throw new CliError(`backend build for ${plugin} produced no backend-artifact.json`);
  }

  let value: unknown;

  try {
    value = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new CliError(`malformed backend artifact for ${plugin}: ${(error as Error).message}`);
  }

  let artifact: BackendBuildResult;

  try {
    artifact = parseBackendArtifact(value);
  } catch (error) {
    throw new CliError(
      `malformed backend artifact for ${plugin} at ${artifactPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (artifact.plugin !== plugin) {
    throw new CliError(`backend artifact plugin mismatch: expected ${plugin}, got ${String(artifact.plugin)}`);
  }

  if (artifact.target !== target) {
    throw new CliError(`backend artifact target mismatch: expected ${target}, got ${String(artifact.target)}`);
  }

  for (const [index, binary] of artifact.binaries.entries()) {
    const source = binary.source;

    const sourcePath = resolve(outDir, source);
    const sourceRelative = relative(resolve(outDir), sourcePath);

    if (
      sourceRelative.startsWith('..') || isAbsolute(sourceRelative) || !existsSync(sourcePath)
      || !statSync(sourcePath).isFile()
    ) {
      throw new CliError(`backend artifact binary ${index} source is outside output directory: ${source}`);
    }
  }

  return artifact;
}

export function buildBackend(options: BackendBuildOptions): BackendBuildResult | null {
  const packagePath = resolve(options.pluginDir, 'package.json');
  let packageJson: PluginPackage;

  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as PluginPackage;
  } catch (error) {
    throw new CliError(`failed to read plugin package.json: ${(error as Error).message}`);
  }

  const script = packageJson.mndw?.backendBuildScript;

  if (typeof script !== 'string' || script.length === 0) {
    return null;
  }

  if (!isProductTarget(options.target)) {
    throw new CliError(`unknown product target: ${options.target}`);
  }

  if (packageJson.scripts?.[script] === undefined) {
    throw new CliError(`backend build script is not defined: ${script}`);
  }

  const outDir = resolve(options.outDir);
  const spawn = options.spawn ?? ((command, args, spawnOptions) => crossSpawn.sync(command, args, spawnOptions));
  const result = spawn('pnpm', [
    'run',
    script,
    '--',
    '--target',
    options.target,
    '--out-dir',
    outDir,
  ], {
    cwd: resolve(options.pluginDir),
    stdio: 'inherit',
  });

  if (result.error || result.status !== 0) {
    throw new CliError(`backend build failed for ${options.plugin} (exit ${result.status ?? 'signal'})`);
  }

  return readBackendArtifact(outDir, options.plugin, options.target);
}
