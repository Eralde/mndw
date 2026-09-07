import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';
import {type BackendBuildResult, buildBackend} from './backend-build.js';

const temporaryDirectories: string[] = [];

function pluginDirectory(script = 'build-backend'): string {
  const dir = mkdtempSync(join(tmpdir(), 'mndw-backend-hook-'));

  temporaryDirectories.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({mndw: {backendBuildScript: script}, scripts: {[script]: 'ignored'}}),
  );

  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('buildBackend', () => {
  it('skips plugins without a compiled backend hook', () => {
    const dir = pluginDirectory();

    writeFileSync(join(dir, 'package.json'), JSON.stringify({scripts: {build: 'ignored'}}));

    expect(buildBackend({pluginDir: dir, plugin: 'demo', target: 'mipsel', outDir: join(dir, 'out')})).toBeNull();
  });

  it('invokes hook with target and output directory and validates its artifact manifest', () => {
    const dir = pluginDirectory();
    const outDir = join(dir, 'out');
    const calls: string[][] = [];
    const spawn = (command: string, args: readonly string[]): {status: number; error?: Error} => {
      calls.push([command, ...args]);
      mkdirSync(outDir, {recursive: true});
      writeFileSync(join(outDir, 'mndsd'), 'binary');
      writeFileSync(
        join(outDir, 'backend-artifact.json'),
        JSON.stringify({
          plugin: 'demo',
          target: 'mipsel',
          binaries: [{source: 'mndsd', destination: 'backend/mndsd'}],
        }),
      );

      return {status: 0};
    };

    const result = buildBackend({pluginDir: dir, plugin: 'demo', target: 'mipsel', outDir, spawn});

    expect(calls[0]).toEqual(['pnpm', 'run', 'build-backend', '--', '--target', 'mipsel', '--out-dir', outDir]);
    expect(result).toEqual<BackendBuildResult>({
      plugin: 'demo',
      target: 'mipsel',
      binaries: [{source: 'mndsd', destination: 'backend/mndsd'}],
    });
  });

  it('rejects failed hooks, wrong targets, and traversal outputs', () => {
    const dir = pluginDirectory();
    const outDir = join(dir, 'out');

    expect(() =>
      buildBackend({
        pluginDir: dir,
        plugin: 'demo',
        target: 'mipsel',
        outDir,
        spawn: () => ({status: 1}),
      })
    ).toThrow('backend build failed');

    const wrongTargetSpawn = (): {status: number} => {
      mkdirSync(outDir, {recursive: true});
      writeFileSync(
        join(outDir, 'backend-artifact.json'),
        JSON.stringify({plugin: 'demo', target: 'aarch64', binaries: []}),
      );

      return {status: 0};
    };

    expect(() => buildBackend({pluginDir: dir, plugin: 'demo', target: 'mipsel', outDir, spawn: wrongTargetSpawn}))
      .toThrow(
        'target mismatch',
      );

    const traversalSpawn = (): {status: number} => {
      mkdirSync(outDir, {recursive: true});
      writeFileSync(
        join(outDir, 'backend-artifact.json'),
        JSON.stringify({
          plugin: 'demo',
          target: 'mipsel',
          binaries: [{source: '../escape', destination: 'backend/escape'}],
        }),
      );

      return {status: 0};
    };

    expect(() => buildBackend({pluginDir: dir, plugin: 'demo', target: 'mipsel', outDir, spawn: traversalSpawn}))
      .toThrow(
        'malformed backend artifact',
      );
  });

  it('rejects valid artifacts that point to a missing file or directory', () => {
    const dir = pluginDirectory();
    const outDir = join(dir, 'out');
    const writeArtifact = (): void => {
      writeFileSync(
        join(outDir, 'backend-artifact.json'),
        JSON.stringify({
          plugin: 'demo',
          target: 'mipsel',
          binaries: [{source: 'backend/demo', destination: 'backend/demo'}],
        }),
      );
    };

    const missingSpawn = (): {status: number} => {
      mkdirSync(outDir, {recursive: true});
      writeArtifact();

      return {status: 0};
    };

    expect(() => buildBackend({pluginDir: dir, plugin: 'demo', target: 'mipsel', outDir, spawn: missingSpawn}))
      .toThrow('source is outside output directory');

    const directorySpawn = (): {status: number} => {
      mkdirSync(join(outDir, 'backend', 'demo'), {recursive: true});
      writeArtifact();

      return {status: 0};
    };

    expect(() => buildBackend({pluginDir: dir, plugin: 'demo', target: 'mipsel', outDir, spawn: directorySpawn}))
      .toThrow('source is outside output directory');
  });
});
