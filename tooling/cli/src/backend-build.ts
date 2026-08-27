import {type SpawnSyncOptions} from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';

import {CliError} from './errors.js';
import {type ProductTarget, isProductTarget} from '../../../build/targets.js';

export interface BackendArtifact {
  readonly source: string;
  readonly destination: string;
}

export interface BackendBuildResult {
  readonly plugin: string;
  readonly target: ProductTarget;
  readonly binaries: readonly BackendArtifact[];
}

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

interface RawBackendArtifact {
  readonly binaries?: unknown;
  readonly plugin?: unknown;
  readonly target?: unknown;
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

  if (typeof value !== 'object' || value === null) {
    throw new CliError(`malformed backend artifact for ${plugin}`);
  }

  const artifact = value as RawBackendArtifact;

  if (artifact.plugin !== plugin) {
    throw new CliError(`backend artifact plugin mismatch: expected ${plugin}, got ${String(artifact.plugin)}`);
  }

  if (artifact.target !== target) {
    throw new CliError(`backend artifact target mismatch: expected ${target}, got ${String(artifact.target)}`);
  }

  if (!Array.isArray(artifact.binaries)) {
    throw new CliError(`backend artifact binaries must be an array for ${plugin}`);
  }

  const destinations = new Set<string>();
  const binaries: BackendArtifact[] = [];

  for (const [index, binary] of artifact.binaries.entries()) {
    if (!isRecord(binary) || !isSafeRelativePath(binary.source) || !isSafeRelativePath(binary.destination)) {
      throw new CliError(`backend artifact binary ${index} has a path outside output directory`);
    }

    const source = binary.source;
    const destination = binary.destination;

    const sourcePath = resolve(outDir, source);
    const sourceRelative = relative(resolve(outDir), sourcePath);

    if (
      sourceRelative.startsWith('..') || isAbsolute(sourceRelative) || !existsSync(sourcePath)
      || !statSync(sourcePath).isFile()
    ) {
      throw new CliError(`backend artifact binary ${index} source is outside output directory: ${source}`);
    }

    if (destinations.has(destination)) {
      throw new CliError(`duplicate backend artifact destination: ${destination}`);
    }

    destinations.add(destination);
    binaries.push({source, destination});
  }

  return {plugin, target, binaries};
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
