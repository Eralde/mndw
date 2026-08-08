import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {createProgram} from './index.js';

interface ExecutionResult {
  readonly stderr: string;
  readonly stdout: string;
}

interface CliResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');
const CLI_ROOT = resolve(WORKSPACE_ROOT, 'tooling/cli');
const temporaryDirectories: string[] = [];

function createPluginDirectory(manifest: string): string {
  const pluginDir = mkdtempSync(resolve(tmpdir(), 'mndw-cli-command-'));

  temporaryDirectories.push(pluginDir);
  writeFileSync(resolve(pluginDir, 'manifest.json'), manifest);

  return pluginDir;
}

const VALID_MANIFEST = JSON.stringify({
  manifestVersion: 3,
  name: 'source-entry-plugin',
  version: '0.1.0',
  type: 'page',
  label: 'Source Entry Plugin',
  route: '/source-entry',
  entry: 'index.js',
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {force: true, recursive: true});
  }
});

function expectExpectedError(result: CliResult, message: string, path: string): void {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.stderr).toContain(path);
  expect(result.stderr).not.toMatch(/\bat\s+.+\(.+\.ts:\d+:\d+\)/);
}

function runPnpm(args: string[]): string {
  return execFileSync('pnpm', args, {cwd: WORKSPACE_ROOT, encoding: 'utf8'});
}

function runCli(args: string[]): CliResult {
  const result = spawnSync('pnpm', ['exec', 'mndw', ...args], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });

  return {status: result.status, stderr: result.stderr, stdout: result.stdout};
}

function runCliFrom(cwd: string, args: string[]): CliResult {
  const result = spawnSync(
    resolve(WORKSPACE_ROOT, 'node_modules/.bin/tsx'),
    [resolve(CLI_ROOT, 'src/index.ts'), ...args],
    {cwd, encoding: 'utf8'},
  );

  return {status: result.status, stderr: result.stderr, stdout: result.stdout};
}

function execute(args: string[]): {result: ExecutionResult; run: Promise<unknown>} {
  let stdout = '';
  let stderr = '';
  const program = createProgram();

  for (const command of [program, ...program.commands]) {
    command.configureOutput({
      writeErr: (message: string): void => {
        stderr += message;
      },
      writeOut: (message: string): void => {
        stdout += message;
      },
    });
    command.exitOverride();
  }

  return {
    result: {get stderr() {
      return stderr;
    }, get stdout() {
      return stdout;
    }},
    run: program.parseAsync(['node', 'mndw', ...args], {from: 'node'}),
  };
}

describe('createProgram', () => {
  test('creates mndw program with the implemented commands', () => {
    const program = createProgram();

    expect(program.name()).toBe('mndw');
    expect(program.commands.map((command) => command.name())).toEqual([
      'create',
      'dev',
      'validate',
      'pack',
      'zip',
    ]);
  });

  test('prints help', async () => {
    const execution = execute(['--help']);

    await expect(execution.run).rejects.toMatchObject({code: 'commander.helpDisplayed', exitCode: 0});
    expect(execution.result.stdout).toContain('Usage: mndw');
    expect(execution.result.stdout).toContain('validate <plugin-dir>');
    expect(execution.result.stderr).toBe('');
  });

  test('reports unknown command cleanly', async () => {
    const execution = execute(['unknown']);

    await expect(execution.run).rejects.toMatchObject({code: 'commander.unknownCommand', exitCode: 1});
    expect(execution.result.stderr).toContain('error: unknown command \'unknown\'');
  });

  test('reports missing validate plugin directory cleanly', async () => {
    const execution = execute(['validate']);

    await expect(execution.run).rejects.toMatchObject({code: 'commander.missingArgument', exitCode: 1});
    expect(execution.result.stderr).toContain('error: missing required argument \'plugin-dir\'');
  });

  test('validates plugin manifest and prints its name and resolved path', () => {
    const pluginDir = 'plugins/builtin/demo-page';
    const result = runCli(['validate', pluginDir]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('demo-page');
    expect(result.stdout).toContain(resolve(WORKSPACE_ROOT, pluginDir));
  });

  test('exits nonzero without a stack trace for expected validation errors', () => {
    const result = runCli(['validate', 'missing-plugin']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(resolve(WORKSPACE_ROOT, 'missing-plugin'));
    expect(result.stderr).not.toMatch(/\bat\s+.+\(.+\.ts:\d+:\d+\)/);
  });

  test('reports a file plugin directory as a manifest read error without a stack trace', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'mndw-cli-file-'));

    temporaryDirectories.push(directory);

    const pluginPath = resolve(directory, 'not-a-plugin-directory');

    writeFileSync(pluginPath, 'not a directory');

    const result = runCli(['validate', pluginPath]);

    expectExpectedError(result, 'Failed to read manifest', resolve(pluginPath, 'manifest.json'));
  });

  test('reports missing source entry for a valid manifest without a stack trace', () => {
    const pluginDir = createPluginDirectory(VALID_MANIFEST);
    const result = runCli(['validate', pluginDir]);

    expectExpectedError(result, 'Missing source entry', resolve(pluginDir, 'src/index.ts'));
  });

  test('reports missing configured production entry without a stack trace', () => {
    const pluginDir = createPluginDirectory(VALID_MANIFEST);

    mkdirSync(resolve(pluginDir, 'src'));
    writeFileSync(resolve(pluginDir, 'src/index.ts'), 'export {}');
    writeFileSync(
      resolve(pluginDir, 'package.json'),
      JSON.stringify({mndw: {productionEntry: 'src/index.prod.ts'}}),
    );

    const result = runCli(['validate', pluginDir]);

    expectExpectedError(result, 'Missing production entry', resolve(pluginDir, 'src/index.prod.ts'));
  });

  test('reports malformed manifest JSON without a stack trace', () => {
    const pluginDir = createPluginDirectory('{');
    const result = runCli(['validate', pluginDir]);

    expectExpectedError(result, 'Failed to parse manifest', resolve(pluginDir, 'manifest.json'));
  });

  test('reports SDK-invalid manifest with its path and no stack trace', () => {
    const pluginDir = createPluginDirectory(JSON.stringify({manifestVersion: 3, name: 'broken-plugin'}));
    const result = runCli(['validate', pluginDir]);

    expectExpectedError(result, 'Invalid manifest for "broken-plugin"', resolve(pluginDir, 'manifest.json'));
  });

  test('resolves relative plugin directories from child process working directory', () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'mndw-cli-cwd-'));

    temporaryDirectories.push(cwd);

    const pluginDir = resolve(cwd, 'plugin');

    mkdirSync(pluginDir);
    mkdirSync(resolve(pluginDir, 'src'));
    writeFileSync(resolve(pluginDir, 'src/index.ts'), 'export {}');
    writeFileSync(
      resolve(pluginDir, 'manifest.json'),
      JSON.stringify({
        manifestVersion: 3,
        name: 'cwd-plugin',
        version: '0.1.0',
        type: 'page',
        label: 'CWD Plugin',
        route: '/cwd',
        entry: 'index.js',
      }),
    );

    const result = runCliFrom(cwd, ['validate', 'plugin']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(resolve(pluginDir, 'manifest.json'));
  });

  test('create --framework vue scaffolds a Vue plugin end to end', () => {
    const workdir = mkdtempSync(resolve(tmpdir(), 'mndw-cli-create-vue-'));

    temporaryDirectories.push(workdir);

    const result = runCliFrom(workdir, ['create', 'vue-cmd', '--framework', 'vue']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(vue)');
    expect(existsSync(resolve(workdir, 'vue-cmd', 'src', 'App.vue'))).toBe(true);
  });

  test('create --framework angular scaffolds an Angular plugin end to end', () => {
    const workdir = mkdtempSync(resolve(tmpdir(), 'mndw-cli-create-ng-'));

    temporaryDirectories.push(workdir);

    const result = runCliFrom(workdir, ['create', 'ng-cmd', '--framework', 'angular']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(angular)');
    expect(existsSync(resolve(workdir, 'ng-cmd', 'src', 'app.component.ts'))).toBe(true);
  });

  test('create --help lists all framework options', () => {
    const result = runCliFrom(WORKSPACE_ROOT, ['create', '--help']);

    expect(result.stdout).toContain('vanilla|svelte|vue|angular');
  });
});

describe('CLI workspace integration', () => {
  test('declares Node types directly', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(WORKSPACE_ROOT, 'tooling/cli/package.json'), 'utf8'),
    ) as {devDependencies?: Record<string, string>};

    expect(packageJson.devDependencies?.['@types/node']).toBeDefined();
  });

  test('invokes mndw through pnpm exec', () => {
    const output = runPnpm(['--filter', '@mndw/cli', 'exec', 'mndw', '--help']);

    expect(output).toContain('Usage: mndw');
  });

  test('invokes linked mndw through root pnpm exec', () => {
    const output = runPnpm(['exec', 'mndw', '--help']);

    expect(output).toContain('Usage: mndw');
  });

  test('type checks without emitting files', () => {
    expect(() => runPnpm(['--filter', '@mndw/cli', 'check'])).not.toThrow();
  });
});
