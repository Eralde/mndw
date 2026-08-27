import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {availableParallelism, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {promoteDirectory} from '../tooling/cli/src/promote-directory.js';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(repoRoot, 'plugins/builtin');
const development = process.argv.includes('--dev');

export interface CommandStep {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

type BuildMode = 'all' | 'frontend' | 'backend';

export interface BuiltinBuilderOptions {
  readonly sourceRoot?: string;
  readonly distRoot?: string;
  readonly outputRoot?: string;
  readonly development?: boolean;
  readonly repoRoot?: string;
}

export interface BuiltinBuilderDeps {
  readonly runStep?: (step: CommandStep) => Promise<string>;
  readonly makeTempDir?: (prefix: string) => string;
  readonly promote?: (source: string, destination: string) => void;
}

// Run one child process, buffering its output so parallel builds don't interleave.
function run(step: CommandStep): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(step.command, [...step.args], {cwd: step.cwd, stdio: ['ignore', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));

    child.on('error', (error) => rejectPromise(error));
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8');

      if (code !== 0) {
        rejectPromise(new Error(`${step.command} ${step.args.join(' ')} failed (exit ${code ?? 'null'})\n${output}`));

        return;
      }

      resolvePromise(output);
    });
  });
}

export function discoverBuiltinPlugins(root = sourceRoot): string[] {
  return readdirSync(root)
    .filter((name) => name !== 'dist' && !name.startsWith('.'))
    .filter((name) => existsSync(join(root, name, 'manifest.json')))
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

function stepsFor(
  name: string,
  options: Required<Pick<BuiltinBuilderOptions, 'sourceRoot' | 'outputRoot' | 'repoRoot' | 'development'>>,
  mode: BuildMode,
): CommandStep[] {
  const pluginDir = join(options.sourceRoot, name);
  const outDir = join(options.outputRoot, name);
  const packageJson = join(pluginDir, 'package.json');

  const packageContents = existsSync(packageJson)
    ? JSON.parse(readFileSync(packageJson, 'utf8')) as {
      readonly scripts?: Record<string, unknown>;
      readonly mndw?: {readonly backendBuildScript?: unknown};
    }
    : undefined;

  const backendBuildScript = typeof packageContents?.mndw?.backendBuildScript === 'string'
    ? packageContents.mndw.backendBuildScript
    : undefined;
  const steps: CommandStep[] = [];

  if (
    (mode === 'all' || mode === 'frontend')
    && packageContents?.scripts?.build !== undefined
    && backendBuildScript === undefined
  ) {
    steps.push({command: 'pnpm', args: ['run', 'build'], cwd: pluginDir});
  }

  if (mode === 'backend' && backendBuildScript !== undefined) {
    steps.push({command: 'pnpm', args: ['run', backendBuildScript], cwd: pluginDir});
  }

  const packArgs = ['--filter', '@mndw/cli', 'exec', 'mndw', 'pack', pluginDir, '--out-dir', outDir];

  if (options.development) {
    packArgs.push('--dev');
  }

  if (mode !== 'all') {
    packArgs.push('--skip-backend-build');
  }

  steps.push({command: 'pnpm', args: packArgs, cwd: options.repoRoot});

  return steps;
}

function builderOptions(options: BuiltinBuilderOptions, outputRoot: string): Required<
  Pick<BuiltinBuilderOptions, 'sourceRoot' | 'outputRoot' | 'repoRoot' | 'development'>
> {
  return {
    sourceRoot: options.sourceRoot ?? sourceRoot,
    outputRoot,
    repoRoot: options.repoRoot ?? repoRoot,
    development: options.development ?? development,
  };
}

async function runBuildSteps(
  name: string,
  options: Required<Pick<BuiltinBuilderOptions, 'sourceRoot' | 'outputRoot' | 'repoRoot' | 'development'>>,
  mode: BuildMode,
  runStep: (step: CommandStep) => Promise<string>,
): Promise<void> {
  const outputs: string[] = [];

  for (const step of stepsFor(name, options, mode)) {
    outputs.push(await runStep(step));
  }

  process.stdout.write(`\n=== ${name} ===\n${outputs.join('')}`);
}

/** Builds one builtin with its complete frontend/backend packaging sequence. */
export async function buildOne(
  name: string,
  options: BuiltinBuilderOptions = {},
  deps: BuiltinBuilderDeps = {},
): Promise<void> {
  if (options.outputRoot === undefined) {
    await buildGranular(name, 'all', options, deps);

    return;
  }

  const outputRoot = options.outputRoot ?? options.distRoot ?? join(options.sourceRoot ?? sourceRoot, 'dist');

  await runBuildSteps(name, builderOptions(options, outputRoot), 'all', deps.runStep ?? run);
}

async function buildGranular(
  name: string,
  mode: BuildMode,
  options: BuiltinBuilderOptions,
  deps: BuiltinBuilderDeps,
): Promise<void> {
  const distRoot = options.distRoot ?? join(options.sourceRoot ?? sourceRoot, 'dist');
  const makeTempDir = deps.makeTempDir ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  const stagedRoot = makeTempDir('mndw-builtin-granular-');

  try {
    await runBuildSteps(name, builderOptions(options, stagedRoot), mode, deps.runStep ?? run);
    mkdirSync(distRoot, {recursive: true});
    (deps.promote ?? promoteDirectory)(join(stagedRoot, name), join(distRoot, name));
  } finally {
    if (existsSync(stagedRoot)) {
      rmSync(stagedRoot, {recursive: true, force: true});
    }
  }
}

/** Rebuilds and atomically promotes only one builtin's frontend artifact. */
export function buildFrontend(
  name: string,
  options: BuiltinBuilderOptions = {},
  deps: BuiltinBuilderDeps = {},
): Promise<void> {
  return buildGranular(name, 'frontend', options, deps);
}

/** Rebuilds and atomically promotes only one builtin's backend artifact. */
export function buildBackend(
  name: string,
  options: BuiltinBuilderOptions = {},
  deps: BuiltinBuilderDeps = {},
): Promise<void> {
  return buildGranular(name, 'backend', options, deps);
}

// Bounded worker pool: at most `limit` plugins build concurrently.
export async function runPool(
  names: readonly string[],
  options: BuiltinBuilderOptions,
  limit: number,
  buildOneFn: (name: string, options: BuiltinBuilderOptions) => Promise<void> = buildOne,
): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (next < names.length) {
      const name = names[next++];

      await buildOneFn(name, options);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, names.length));

  await Promise.all(Array.from({length: workerCount}, () => worker()));
}

async function main(): Promise<void> {
  const plugins = discoverBuiltinPlugins();
  const outputRoot = mkdtempSync(join(sourceRoot, '.mndw-builtin-'));

  const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
  const parsed = concurrencyArg === undefined ? Number.NaN : Number.parseInt(concurrencyArg.split('=')[1], 10);
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : availableParallelism();

  try {
    await runPool(plugins, {sourceRoot, outputRoot, development}, limit);

    promoteDirectory(outputRoot, join(sourceRoot, 'dist'));
  } catch (error) {
    if (existsSync(outputRoot)) {
      rmSync(outputRoot, {recursive: true, force: true});
    }

    throw error;
  }

  process.stdout.write(`\nPacked ${plugins.length} built-in plugins: ${plugins.join(', ')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
