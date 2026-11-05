import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';
import {pack} from 'tar-stream';
import {createGzip} from 'node:zlib';
import {checkTarball} from './check-tarball.js';

const temporaryDirectories: string[] = [];

const makeTarball = async (
  packageJson: Record<string, unknown>,
  files: Record<string, string> = {},
  modes: Record<string, number> = {},
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'mndw-check-tarball-'));

  temporaryDirectories.push(directory);

  const tarballPath = join(directory, 'fixture.tgz');
  const archive = pack();
  const entries = {'package/package.json': JSON.stringify(packageJson), ...files};

  for (const [name, contents] of Object.entries(entries)) {
    archive.entry({name, mode: modes[name] ?? 0o644}, contents);
  }

  archive.finalize();
  await pipeline(archive, createGzip(), createWriteStream(tarballPath));

  return tarballPath;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe('checkTarball', () => {
  it('accepts a package with declared imports and existing JavaScript targets', async () => {
    const tarball = await makeTarball({
      name: '@mndw/fixture',
      version: '1.0.0',
      type: 'module',
      exports: {'.': {types: './dist/index.d.ts', default: './dist/index.js'}},
      main: './dist/index.js',
      types: './dist/index.d.ts',
      dependencies: {dep: '^1.0.0'},
    }, {
      'package/dist/index.js':
        'import {readFileSync} from \'node:fs\'; import {value} from \'dep\'; import {self} from \'@mndw/fixture/subpath\'; export {readFileSync, value, self};',
      'package/dist/index.d.ts': 'import type {Value} from \'dep\'; export type {Value};',
    });

    await expect(checkTarball(tarball)).resolves.toEqual([]);
  });

  it('reports workspace ranges in dependency fields', async () => {
    const tarball = await makeTarball({
      name: 'fixture',
      dependencies: {dep: 'workspace:*'},
      peerDependencies: {peer: 'workspace:^'},
      optionalDependencies: {optional: 'workspace:~'},
    });

    await expect(checkTarball(tarball)).resolves.toMatchObject([
      {kind: 'workspace-range'},
      {kind: 'workspace-range'},
      {kind: 'workspace-range'},
    ]);
  });

  it('reports TypeScript source export targets', async () => {
    const tarball = await makeTarball({name: 'fixture', exports: './src/index.ts'});

    await expect(checkTarball(tarball)).resolves.toMatchObject([{kind: 'ts-target'}]);
  });

  it('reports undeclared package imports from declaration files', async () => {
    const tarball = await makeTarball({name: '@scope/fixture'}, {
      'package/dist/index.d.ts': 'import type {X} from \'@scope/undeclared\'; export type {X};',
      'package/dist/other.js': 'import {X} from \'@scope/undeclared/subpath\'; export {X};',
      'package/dist/lazy.mjs': 'export const load = () => import(\'@scope/undeclared/dynamic\');',
    });

    const problems = await checkTarball(tarball);

    expect(problems.map((problem) => problem.kind)).toEqual([
      'undeclared-import',
      'undeclared-import',
      'undeclared-import',
    ]);
  });

  it('does not treat JavaScript strings as import declarations', async () => {
    const tarball = await makeTarball({name: '@mndw/fixture'}, {
      'package/dist/parser.js': 'const parserProbe = "import").prop("package"; export {parserProbe};',
    });

    await expect(checkTarball(tarball)).resolves.toEqual([]);
  });

  it('reports missing export targets', async () => {
    const tarball = await makeTarball({name: 'fixture', exports: './dist/missing.js'});

    await expect(checkTarball(tarball)).resolves.toMatchObject([{kind: 'missing-target'}]);
  });

  it('reports missing bin targets', async () => {
    const tarball = await makeTarball({name: 'fixture', bin: {fixture: './bin/missing.js'}});

    await expect(checkTarball(tarball)).resolves.toMatchObject([{kind: 'missing-target'}]);
  });

  it('reports bin targets without executable mode', async () => {
    const tarball = await makeTarball({name: '@mndw/mndwd-darwin-arm64', bin: {mndwd: './bin/mndwd'}}, {
      'package/bin/mndwd': 'binary',
    }, {'package/bin/mndwd': 0o644});

    await expect(checkTarball(tarball)).resolves.toMatchObject([{kind: 'non-executable-bin'}]);
  });

  it('reports private packages', async () => {
    const tarball = await makeTarball({name: 'fixture', private: true});

    await expect(checkTarball(tarball)).resolves.toMatchObject([{kind: 'private'}]);
  });
});
