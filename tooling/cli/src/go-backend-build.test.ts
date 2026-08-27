import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
import {type GoBuildSpawn, buildGoBackend} from './go-backend-build.js';

const okSpawn = (): ReturnType<GoBuildSpawn> => ({status: 0, signal: null});

describe('buildGoBackend', () => {
  it('builds host binaries hermetically and preserves GOCACHE', () => {
    const calls: Array<{args: string[]; cwd: string; env: NodeJS.ProcessEnv}> = [];
    const original = process.env.GOCACHE;

    process.env.GOCACHE = '/cache/go';

    try {
      const spawn: GoBuildSpawn = (_command, args, options) => {
        calls.push({args, cwd: options.cwd, env: options.env});

        return okSpawn();
      };

      const result = buildGoBackend({
        plugin: 'foo',
        backendDir: '/repo/foo/backend',
        binaryName: 'food',
        entryPackage: './cmd/food',
        spawn,
      });

      expect(result).toEqual({binaryPath: '/repo/foo/backend/food'});
      expect(calls[0]).toMatchObject({
        args: ['build', '-ldflags', '-s -w', '-o', '/repo/foo/backend/food', './cmd/food'],
        cwd: '/repo/foo/backend',
      });
      expect(calls[0]?.env).toMatchObject({GOWORK: 'off', CGO_ENABLED: '0', GOCACHE: '/cache/go'});
    } finally {
      if (original === undefined) {
        delete process.env.GOCACHE;
      } else {
        process.env.GOCACHE = original;
      }
    }
  });

  it('builds cross binaries with hermetic target environment and artifact metadata', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mndw-go-backend-'));

    try {
      const calls: Array<{args: string[]; cwd: string; env: NodeJS.ProcessEnv}> = [];
      const spawn: GoBuildSpawn = (_command, args, options) => {
        calls.push({args, cwd: options.cwd, env: options.env});

        return okSpawn();
      };

      const result = buildGoBackend({
        plugin: 'foo',
        backendDir: '/repo/foo/backend',
        binaryName: 'food',
        entryPackage: './cmd/food',
        target: 'aarch64',
        outDir,
        spawn,
      });

      expect(result.binaryPath).toBe(join(outDir, 'food'));
      expect(result.artifactPath).toBe(join(outDir, 'backend-artifact.json'));
      expect(calls[0]?.env).toMatchObject({
        GOOS: 'linux',
        GOARCH: 'arm64',
        CGO_ENABLED: '0',
        GOWORK: 'off',
      });

      const artifactPath = result.artifactPath;

      if (artifactPath === undefined) {
        throw new Error('cross build did not produce artifact metadata');
      }

      expect(JSON.parse(readFileSync(artifactPath, 'utf8'))).toEqual({
        plugin: 'foo',
        target: 'aarch64',
        binaries: [{source: 'food', destination: 'backend/food'}],
      });
      expect(existsSync(artifactPath)).toBe(true);
    } finally {
      rmSync(outDir, {recursive: true, force: true});
    }
  });

  it('rejects unpaired cross-build options before spawning', () => {
    const spawn: GoBuildSpawn = () => {
      throw new Error('spawn should not run');
    };

    expect(() =>
      buildGoBackend({
        plugin: 'foo',
        backendDir: '/repo/foo/backend',
        binaryName: 'food',
        entryPackage: './cmd/food',
        outDir: '/tmp/out',
        spawn,
      })
    ).toThrow(CliError);
    expect(() =>
      buildGoBackend({
        plugin: 'foo',
        backendDir: '/repo/foo/backend',
        binaryName: 'food',
        entryPackage: './cmd/food',
        target: 'aarch64',
        spawn,
      })
    ).toThrow(CliError);
  });

  it('propagates spawn errors, signal exits, and non-zero statuses', () => {
    const base = {plugin: 'foo', backendDir: '/repo/foo/backend', binaryName: 'food', entryPackage: './cmd/food'};

    expect(() =>
      buildGoBackend({
        ...base,
        spawn: () => ({error: new Error('enoent'), status: null, signal: null}),
      })
    ).toThrow(/food/);
    expect(() =>
      buildGoBackend({
        ...base,
        spawn: () => ({status: 2, signal: null}),
      })
    ).toThrow(/food/);
    expect(() =>
      buildGoBackend({
        ...base,
        spawn: () => ({status: null, signal: 'SIGKILL'}),
      })
    ).toThrow(/SIGKILL/);
  });
});
