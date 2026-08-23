import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {readPluginPackage} from './plugin-package.js';

const temporaryDirectories: string[] = [];

function makePlugin(packageContents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mndw-plugin-package-'));

  temporaryDirectories.push(dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'manifest.json'), '{}');

  if (packageContents !== undefined) {
    writeFileSync(join(dir, 'package.json'), packageContents);
  }

  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {force: true, recursive: true});
  }
});

describe('readPluginPackage', () => {
  it('returns null when package.json is absent', () => {
    expect(readPluginPackage(makePlugin())).toBeNull();
  });

  it('reads valid package metadata', () => {
    const dir = makePlugin(JSON.stringify({
      name: 'sample',
      scripts: {build: 'pnpm run generate'},
      mndw: {productionEntry: 'src/index.prod.ts', backendAssets: ['backend/dns-util']},
    }));

    expect(readPluginPackage(dir)).toEqual({
      name: 'sample',
      scripts: {build: 'pnpm run generate'},
      mndw: {productionEntry: 'src/index.prod.ts', backendAssets: ['backend/dns-util']},
    });
  });

  it('throws CliError for malformed package.json', () => {
    const dir = makePlugin('{');

    expect(() => readPluginPackage(dir)).toThrow(/package\.json/);
  });

  it('throws CliError when package.json is not an object', () => {
    const dir = makePlugin(JSON.stringify(['not', 'an', 'object']));

    expect(() => readPluginPackage(dir)).toThrow(/package\.json/);
  });

  it.each([
    ['empty', []],
    ['non-array', 'backend/dns-util'],
    ['absolute', ['/tmp/dns-util']],
    ['traversal', ['backend/../dns-util']],
    ['duplicate', ['backend/dns-util', 'backend/dns-util']],
  ])('rejects %s backend asset metadata', (_name, backendAssets) => {
    const dir = makePlugin(JSON.stringify({mndw: {backendAssets}}));

    expect(() => readPluginPackage(dir)).toThrow(/backendAssets/);
  });

  it('does not modify package contents while reading', () => {
    const contents = JSON.stringify({name: 'sample'});
    const dir = makePlugin(contents);

    readPluginPackage(dir);

    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(contents);
  });
});
