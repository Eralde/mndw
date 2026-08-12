import {spawn} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {join, resolve} from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(repoRoot, 'plugins/builtin');
const outputRoot = join(sourceRoot, 'dist');
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

function stepsFor(name: string): CommandStep[] {
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
async function buildPlugin(name: string): Promise<void> {
  const outputs: string[] = [];

  for (const step of stepsFor(name)) {
    outputs.push(await run(step));
  }

  process.stdout.write(`\n=== ${name} ===\n${outputs.join('')}`);
}

// Bounded worker pool: at most `limit` plugins build concurrently.
async function runPool(names: readonly string[], limit: number): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (next < names.length) {
      const name = names[next++];

      await buildPlugin(name);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, names.length));

  await Promise.all(Array.from({length: workerCount}, () => worker()));
}

async function main(): Promise<void> {
  const plugins = readdirSync(sourceRoot)
    .filter((name) => name !== 'dist')
    .filter((name) => existsSync(join(sourceRoot, name, 'manifest.json')))
    .filter((name) => statSync(join(sourceRoot, name)).isDirectory())
    .sort();

  const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
  const parsed = concurrencyArg === undefined ? Number.NaN : Number.parseInt(concurrencyArg.split('=')[1], 10);
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : availableParallelism();

  await runPool(plugins, limit);

  process.stdout.write(`\nPacked ${plugins.length} built-in plugins: ${plugins.join(', ')}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
