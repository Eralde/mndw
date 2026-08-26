import {readFileSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';

import {CliError} from './errors.js';
import {type GoBuildSpawn, buildGoBackend} from './go-backend-build.js';
import {type ProductTarget, isProductTarget} from './go-target.js';

export interface BackendBuildArgs {
  readonly target?: string;
  readonly outDir?: string;
}

export interface BackendBuildConfig {
  readonly plugin: string;
  readonly binaryName: string;
  readonly entryPackage: string;
}

export interface RunBuildBackendOptions {
  readonly pluginDir: string;
  readonly args: readonly string[];
  readonly spawn?: GoBuildSpawn;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError(`failed to read ${label} at ${path}: ${(error as Error).message}`);
  }
}

// This strict parser is also the single place the pnpm `--` separator is handled.
// `pnpm run build-backend -- --target ...` forwards ["--","--target",...] (verified:
// pnpm 10.32.1). On the CLI path, commander v15 with allowUnknownOption/
// allowExcessArguments STRIPS that `--` before it reaches command.args (verified), so
// this leading-`--` strip is belt-and-suspenders — it keeps the parser correct for
// direct callers and tests, which pass the raw ["--", ...] form. Do NOT remove it as
// "dead": the two layers disagree about whether `--` is present. Accept either no args
// or exactly `--target <t> --out-dir <d>` (either order); reject duplicates, empty values,
// and anything else.
export function parseBackendBuildArgs(rawArgs: readonly string[]): BackendBuildArgs {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  let target: string | undefined;
  let outDir: string | undefined;
  let index = 0;

  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];

    if (value === undefined) {
      throw new CliError(`build-backend: missing value for ${flag}`);
    }

    if (value.length === 0) {
      throw new CliError(`build-backend: ${flag} must be a non-empty value`);
    }

    if (flag === '--target') {
      if (target !== undefined) {
        throw new CliError('build-backend: duplicate --target');
      }

      target = value;
    } else if (flag === '--out-dir') {
      if (outDir !== undefined) {
        throw new CliError('build-backend: duplicate --out-dir');
      }

      outDir = value;
    } else {
      throw new CliError(`build-backend: unexpected argument ${flag}`);
    }

    index += 2;
  }

  if ((target === undefined) !== (outDir === undefined)) {
    throw new CliError('build-backend: --target and --out-dir must be provided together');
  }

  return {target, outDir};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeBinaryName(value: unknown): value is string {
  return nonEmptyString(value)
    && !isAbsolute(value)
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..';
}

function isSafeEntryPackage(value: unknown): value is string {
  return nonEmptyString(value)
    && !isAbsolute(value)
    && !value.startsWith('\\')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

export function readBackendBuildConfig(pluginDir: string): BackendBuildConfig {
  const dir = resolve(pluginDir);
  const manifestValue = readJson(join(dir, 'manifest.json'), 'manifest.json');
  const packageValue = readJson(join(dir, 'package.json'), 'package.json');

  if (!isRecord(manifestValue)) {
    throw new CliError(`manifest.json in ${dir} must contain a JSON object`);
  }

  if (!isRecord(packageValue)) {
    throw new CliError(`package.json in ${dir} must contain a JSON object`);
  }

  const plugin = manifestValue.name;
  const mndw = isRecord(packageValue.mndw) ? packageValue.mndw : undefined;
  const backend = mndw !== undefined && isRecord(mndw.backend) ? mndw.backend : undefined;
  const binaryName = backend?.binaryName;
  const entryPackage = backend?.entryPackage;

  if (!nonEmptyString(plugin)) {
    throw new CliError(`manifest.json in ${dir} must set a non-empty "name"`);
  }

  if (!isSafeBinaryName(binaryName)) {
    throw new CliError(`mndw.backend in ${dir}/package.json must set a safe binaryName`);
  }

  if (!isSafeEntryPackage(entryPackage)) {
    throw new CliError(`mndw.backend in ${dir}/package.json must set a safe relative entryPackage`);
  }

  return {plugin, binaryName, entryPackage};
}

export function runBuildBackendCommand(options: RunBuildBackendOptions): void {
  const {target, outDir} = parseBackendBuildArgs(options.args);

  let productTarget: ProductTarget | undefined;

  if (target !== undefined) {
    if (!isProductTarget(target)) {
      throw new CliError(`unknown product target: ${target}`);
    }

    productTarget = target;
  }

  const config = readBackendBuildConfig(options.pluginDir);

  buildGoBackend({
    plugin: config.plugin,
    backendDir: join(resolve(options.pluginDir), 'backend'),
    binaryName: config.binaryName,
    entryPackage: config.entryPackage,
    target: productTarget,
    outDir,
    spawn: options.spawn,
  });
}
