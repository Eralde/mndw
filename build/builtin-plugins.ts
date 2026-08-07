import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(repoRoot, 'plugins/builtin');
const outputRoot = join(sourceRoot, 'dist');
const development = process.argv.includes('--dev');

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {cwd, stdio: 'inherit'});

  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

function main(): void {
  const plugins = readdirSync(sourceRoot)
    .filter((name) => name !== 'dist')
    .filter((name) => existsSync(join(sourceRoot, name, 'manifest.json')))
    .filter((name) => statSync(join(sourceRoot, name)).isDirectory())
    .sort();

  for (const name of plugins) {
    const pluginDir = join(sourceRoot, name);
    const outDir = join(outputRoot, name);
    const packageJson = join(pluginDir, 'package.json');

    const packageContents = existsSync(packageJson)
      ? JSON.parse(readFileSync(packageJson, 'utf8')) as {
        readonly scripts?: Record<string, unknown>;
        readonly mndw?: {readonly backendBuildScript?: unknown};
      }
      : undefined;

    if (
      packageContents?.scripts?.build !== undefined
      && typeof packageContents.mndw?.backendBuildScript !== 'string'
    ) {
      run('pnpm', ['run', 'build'], pluginDir);
    }

    const args = ['--filter', '@mndw/cli', 'exec', 'mndw', 'pack', pluginDir, '--out-dir', outDir];

    if (development) {
      args.push('--dev');
    }

    run('pnpm', args, repoRoot);
  }

  process.stdout.write(`Packed ${plugins.length} built-in plugins: ${plugins.join(', ')}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
