import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
import {type GoBuildSpawn} from './go-backend-build.js';
import {parseBackendBuildArgs, readBackendBuildConfig, runBuildBackendCommand} from './backend-build-run.js';

const temporaryDirectories: string[] = [];

function pluginDirectory(options: {name?: unknown; backend?: unknown} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'mndw-build-run-'));

  temporaryDirectories.push(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({name: options.name ?? 'demo'}));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({mndw: {backendBuildScript: 'build-backend', backend: options.backend}}),
  );

  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('parseBackendBuildArgs', () => {
  it('returns empty for no args (local host build)', () => {
    expect(parseBackendBuildArgs([])).toEqual({});
  });

  it('parses --target and --out-dir', () => {
    expect(parseBackendBuildArgs(['--target', 'aarch64', '--out-dir', '/out'])).toEqual({
      target: 'aarch64',
      outDir: '/out',
    });
  });

  it('strips a leading pnpm-forwarded "--" separator', () => {
    expect(parseBackendBuildArgs(['--', '--target', 'aarch64', '--out-dir', '/out'])).toEqual({
      target: 'aarch64',
      outDir: '/out',
    });
  });

  it('rejects --target without --out-dir', () => {
    expect(() => parseBackendBuildArgs(['--target', 'aarch64'])).toThrow(CliError);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseBackendBuildArgs(['--frobnicate', 'x'])).toThrow(CliError);
  });

  it('rejects an empty output directory', () => {
    expect(() => parseBackendBuildArgs(['--target', 'aarch64', '--out-dir', ''])).toThrow(CliError);
  });

  it('rejects duplicate flags', () => {
    expect(() =>
      parseBackendBuildArgs([
        '--target',
        'aarch64',
        '--target',
        'mips',
        '--out-dir',
        '/out',
      ])
    ).toThrow(CliError);
  });
});

describe('readBackendBuildConfig', () => {
  it('reads plugin name from manifest.json and binaryName/entryPackage from mndw.backend', () => {
    const dir = pluginDirectory({name: 'demo', backend: {binaryName: 'demod', entryPackage: './cmd/demod'}});

    expect(readBackendBuildConfig(dir)).toEqual({
      plugin: 'demo',
      binaryName: 'demod',
      entryPackage: './cmd/demod',
    });
  });

  it('throws a CliError when mndw.backend is missing', () => {
    const dir = pluginDirectory({name: 'demo', backend: undefined});

    expect(() => readBackendBuildConfig(dir)).toThrow(CliError);
  });

  it('throws a CliError when a backend field is empty', () => {
    const dir = pluginDirectory({name: 'demo', backend: {binaryName: '', entryPackage: './cmd/demod'}});

    expect(() => readBackendBuildConfig(dir)).toThrow(CliError);
  });

  it('throws a CliError for malformed JSON shapes', () => {
    const dir = pluginDirectory({name: 'demo', backend: {binaryName: 'demod', entryPackage: './cmd/demod'}});

    writeFileSync(join(dir, 'manifest.json'), 'null');
    expect(() => readBackendBuildConfig(dir)).toThrow(CliError);

    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({name: 'demo'}));
    writeFileSync(join(dir, 'package.json'), 'null');
    expect(() => readBackendBuildConfig(dir)).toThrow(CliError);
  });

  it('rejects unsafe binary and entry-package paths', () => {
    const binaryPath = pluginDirectory({
      name: 'demo',
      backend: {binaryName: '../demod', entryPackage: './cmd/demod'},
    });
    const entryPath = pluginDirectory({
      name: 'demo',
      backend: {binaryName: 'demod', entryPackage: '../cmd/demod'},
    });

    expect(() => readBackendBuildConfig(binaryPath)).toThrow(CliError);
    expect(() => readBackendBuildConfig(entryPath)).toThrow(CliError);
  });
});

describe('runBuildBackendCommand', () => {
  const okSpawn: GoBuildSpawn = () => ({status: 0, signal: null});

  it('builds the host binary from ./backend when no target is given', () => {
    const dir = pluginDirectory({name: 'demo', backend: {binaryName: 'demod', entryPackage: './cmd/demod'}});
    const calls: Array<{args: string[]; cwd: string}> = [];
    const spawn: GoBuildSpawn = (_command, args, spawnOptions) => {
      calls.push({args, cwd: spawnOptions.cwd});

      return {status: 0, signal: null};
    };

    runBuildBackendCommand({pluginDir: dir, args: [], spawn});

    expect(calls[0]?.cwd).toBe(join(dir, 'backend'));
    expect(calls[0]?.args).toEqual([
      'build',
      '-ldflags',
      '-s -w',
      '-o',
      join(dir, 'backend', 'demod'),
      './cmd/demod',
    ]);
  });

  it('cross-builds when the pnpm-forwarded "--" args are passed through', () => {
    const dir = pluginDirectory({name: 'demo', backend: {binaryName: 'demod', entryPackage: './cmd/demod'}});
    const outDir = join(dir, 'out');
    const calls: Array<{args: string[]}> = [];
    const spawn: GoBuildSpawn = (_command, args) => {
      calls.push({args});

      return {status: 0, signal: null};
    };

    runBuildBackendCommand({pluginDir: dir, args: ['--', '--target', 'aarch64', '--out-dir', outDir], spawn});

    expect(calls[0]?.args).toEqual([
      'build',
      '-ldflags',
      '-s -w',
      '-o',
      join(outDir, 'demod'),
      './cmd/demod',
    ]);
  });

  it('rejects an unknown --target before spawning', () => {
    const dir = pluginDirectory({name: 'demo', backend: {binaryName: 'demod', entryPackage: './cmd/demod'}});

    expect(() =>
      runBuildBackendCommand({pluginDir: dir, args: ['--target', 'not-a-target', '--out-dir', '/out'], spawn: okSpawn})
    ).toThrow(CliError);
  });
});
