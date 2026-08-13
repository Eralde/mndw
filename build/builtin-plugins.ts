import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(repoRoot, 'plugins/builtin');
const development = process.argv.includes('--dev');

interface CommandStep {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
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

function stepsFor(name: string, outputRoot: string): CommandStep[] {
  const pluginDir = join(sourceRoot, name);
  const outDir = join(outputRoot, name);
  const packageJson = join(pluginDir, 'package.json');

  const packageContents = existsSync(packageJson)
    ? JSON.parse(readFileSync(packageJson, 'utf8')) as {
      readonly scripts?: Record<string, unknown>;
      readonly mndw?: {readonly backendBuildScript?: unknown};
    }
    : undefined;

  const steps: CommandStep[] = [];

  if (
    packageContents?.scripts?.build !== undefined
    && typeof packageContents.mndw?.backendBuildScript !== 'string'
  ) {
    steps.push({command: 'pnpm', args: ['run', 'build'], cwd: pluginDir});
  }

  const packArgs = ['--filter', '@mndw/cli', 'exec', 'mndw', 'pack', pluginDir, '--out-dir', outDir];

  if (development) {
    packArgs.push('--dev');
  }

  steps.push({command: 'pnpm', args: packArgs, cwd: repoRoot});

  return steps;
}

// Build a single plugin: its steps run sequentially, output flushed as one block.
async function buildPlugin(name: string, outputRoot: string): Promise<void> {
  const outputs: string[] = [];

  for (const step of stepsFor(name, outputRoot)) {
    outputs.push(await run(step));
  }

  process.stdout.write(`\n=== ${name} ===\n${outputs.join('')}`);
}

// Bounded worker pool: at most `limit` plugins build concurrently.
async function runPool(names: readonly string[], outputRoot: string, limit: number): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (next < names.length) {
      const name = names[next++];

      await buildPlugin(name, outputRoot);
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
    await runPool(plugins, outputRoot, limit);

    const publishedRoot = join(sourceRoot, 'dist');
    const backupRoot = `${publishedRoot}.previous`;

    if (existsSync(publishedRoot)) {
      renameSync(publishedRoot, backupRoot);
    }

    try {
      renameSync(outputRoot, publishedRoot);
    } catch (error) {
      if (existsSync(backupRoot)) {
        renameSync(backupRoot, publishedRoot);
      }

      throw error;
    }

    if (existsSync(backupRoot)) {
      rmSync(backupRoot, {recursive: true, force: true});
    }
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
