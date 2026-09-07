import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {type BackendBuildResult} from './backend-artifact.js';
import {CliError} from './errors.js';
import {type ProductTarget, goTargetEnvironment} from './go-target.js';

export type GoBuildSpawn = (
  command: string,
  args: string[],
  options: {cwd: string; env: NodeJS.ProcessEnv},
) => {error?: Error; status: number | null; signal: NodeJS.Signals | null};

export interface BuildGoBackendOptions {
  readonly plugin: string;
  readonly backendDir: string;
  readonly binaryName: string;
  readonly entryPackage: string;
  readonly target?: ProductTarget;
  readonly outDir?: string;
  readonly spawn?: GoBuildSpawn;
}

export interface BuildGoBackendResult {
  readonly binaryPath: string;
  readonly artifactPath?: string;
}

const defaultSpawn: GoBuildSpawn = (command, args, options) =>
  spawnSync(command, args, {cwd: options.cwd, env: options.env, stdio: 'inherit'});

export function buildGoBackend(options: BuildGoBackendOptions): BuildGoBackendResult {
  const {plugin, backendDir, binaryName, entryPackage, target, outDir} = options;

  if ((target === undefined) !== (outDir === undefined)) {
    throw new CliError(`${plugin}: cross build requires both --target and --out-dir`);
  }

  const crossMode = target !== undefined && outDir !== undefined;
  const destinationDir = crossMode ? resolve(outDir) : resolve(backendDir);
  const binaryPath = join(destinationDir, binaryName);
  const env: NodeJS.ProcessEnv = crossMode
    ? {...goTargetEnvironment(target), GOWORK: 'off'}
    : {...process.env, GOWORK: 'off', CGO_ENABLED: '0'};

  if (crossMode) {
    mkdirSync(destinationDir, {recursive: true});
  }

  const result = (options.spawn ?? defaultSpawn)('go', [
    'build',
    '-ldflags',
    '-s -w',
    '-o',
    binaryPath,
    entryPackage,
  ], {cwd: resolve(backendDir), env});

  if (result.error) {
    throw new CliError(`go build failed for ${plugin} (${binaryName}): ${result.error.message}`);
  }

  if (result.signal !== null && result.signal !== undefined) {
    throw new CliError(`go build for ${plugin} (${binaryName}) terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new CliError(`go build for ${plugin} (${binaryName}) exited with status ${result.status}`);
  }

  if (!crossMode) {
    return {binaryPath};
  }

  if (target === undefined || outDir === undefined) {
    throw new CliError(`${plugin}: cross build requires both --target and --out-dir`);
  }

  const artifactPath = join(destinationDir, 'backend-artifact.json');
  const artifact: BackendBuildResult = {
    plugin,
    target,
    binaries: [{source: binaryName, destination: `backend/${binaryName}`}],
  };

  writeFileSync(
    artifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  return {binaryPath, artifactPath};
}
