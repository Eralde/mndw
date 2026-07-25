import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
import {resolveProductionSourceEntry} from './source-entry.js';

interface SourceEntryFixture {
  readonly productionEntry?: string;
  readonly productionFile?: string;
}

const temporaryDirectories: string[] = [];

function makeTempPlugin(options: SourceEntryFixture = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'mndw-source-entry-'));
  const manifest = {
    manifestVersion: 2,
    name: 'source-entry-plugin',
    version: '0.1.0',
    type: 'page',
    label: 'Source Entry Plugin',
    route: '/source-entry',
    entry: 'index.js',
  };

  temporaryDirectories.push(dir);
  mkdirSync(join(dir, 'src'), {recursive: true});
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}');

  if (options.productionFile !== undefined) {
    writeFileSync(join(dir, options.productionFile), 'export {}');
  }

  if (options.productionEntry !== undefined) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({mndw: {productionEntry: options.productionEntry}}));
  }

  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {force: true, recursive: true});
  }
});

describe('resolveProductionSourceEntry', () => {
  it('defaults to src/index.ts when the plugin has no package.json', () => {
    expect(resolveProductionSourceEntry(makeTempPlugin())).toBe('src/index.ts');
  });

  it('defaults to src/index.ts when package.json has no mndw configuration', () => {
    const dir = makeTempPlugin();

    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'source-entry-plugin'}));

    expect(resolveProductionSourceEntry(dir)).toBe('src/index.ts');
  });

  it('uses configured productionEntry under src', () => {
    const dir = makeTempPlugin({productionEntry: 'src/index.prod.ts', productionFile: 'src/index.prod.ts'});

    expect(resolveProductionSourceEntry(dir)).toBe('src/index.prod.ts');
  });

  it('accepts an explicit productionEntry of src/index.ts', () => {
    const dir = makeTempPlugin({productionEntry: 'src/index.ts'});

    expect(resolveProductionSourceEntry(dir)).toBe('src/index.ts');
  });

  it.each([
    '../outside.ts',
    'src/../outside.ts',
    '/tmp/index.ts',
    'src/index.js',
    'src\\index.prod.ts',
    '',
    'index.prod.ts',
  ])('rejects unsafe productionEntry %s', (productionEntry) => {
    expect(() => resolveProductionSourceEntry(makeTempPlugin({productionEntry}))).toThrow(CliError);
  });

  it('rejects a non-string productionEntry', () => {
    const dir = makeTempPlugin();

    writeFileSync(join(dir, 'package.json'), JSON.stringify({mndw: {productionEntry: 42}}));

    expect(() => resolveProductionSourceEntry(dir)).toThrow(CliError);
  });

  it('rejects a configured productionEntry that is missing', () => {
    const dir = makeTempPlugin({productionEntry: 'src/index.prod.ts'});

    expect(() => resolveProductionSourceEntry(dir)).toThrow(/production entry/);
  });
});
