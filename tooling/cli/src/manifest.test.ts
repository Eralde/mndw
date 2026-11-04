import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

import {ManifestValidationError} from '@mndw/sdk-internal';
import {afterEach, describe, expect, test} from 'vitest';

import {readManifest, unknownManifestKeys} from './manifest.js';
import {resolvePluginDir} from './paths.js';

const temporaryDirectories: string[] = [];

function createPluginDirectory(manifest?: string): string {
  const pluginDir = mkdtempSync(resolve(tmpdir(), 'mndw-cli-'));

  temporaryDirectories.push(pluginDir);

  if (manifest !== undefined) {
    writeFileSync(resolve(pluginDir, 'manifest.json'), manifest);
  }

  return pluginDir;
}

const VALID_MANIFEST = JSON.stringify({
  manifestVersion: 1,
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

describe('readManifest', () => {
  test('resolves relative plugin directories from process working directory', () => {
    const initCwd = process.env.INIT_CWD;

    process.env.INIT_CWD = resolve(import.meta.dirname, '../../..');

    try {
      expect(resolvePluginDir('plugins/examples/sample-page')).toBe(
        resolve(process.cwd(), 'plugins/examples/sample-page'),
      );
    } finally {
      if (initCwd !== undefined) {
        process.env.INIT_CWD = initCwd;
      } else {
        delete process.env.INIT_CWD;
      }
    }
  });

  test('reports resolved plugin directory when manifest is missing', () => {
    const pluginDir = createPluginDirectory();

    expect(() => readManifest(pluginDir)).toThrow(resolve(pluginDir));
  });

  test('reports parse context for malformed JSON', () => {
    const pluginDir = createPluginDirectory('{');

    expect(() => readManifest(pluginDir)).toThrow(/Failed to parse manifest.*manifest\.json/);
  });

  test('surfaces SDK validation error for invalid manifest', () => {
    const pluginDir = createPluginDirectory(JSON.stringify({manifestVersion: 1, name: 'broken'}));

    expect(() => readManifest(pluginDir)).toThrow(ManifestValidationError);
  });

  test('reports source entry path when a valid manifest has no src/index.ts', () => {
    const pluginDir = createPluginDirectory(VALID_MANIFEST);

    expect(() => readManifest(pluginDir)).toThrow(resolve(pluginDir, 'src/index.ts'));
  });

  test('validates configured productionEntry after validating src/index.ts', () => {
    const pluginDir = createPluginDirectory(VALID_MANIFEST);

    mkdirSync(resolve(pluginDir, 'src'));
    writeFileSync(resolve(pluginDir, 'src/index.ts'), 'export {}');
    writeFileSync(
      resolve(pluginDir, 'package.json'),
      JSON.stringify({mndw: {productionEntry: 'src/index.prod.ts'}}),
    );

    expect(() => readManifest(pluginDir)).toThrow(/Missing production entry/);
  });

  test('returns manifest when valid plugin has a regular src/index.ts', () => {
    const pluginDir = createPluginDirectory(VALID_MANIFEST);

    mkdirSync(resolve(pluginDir, 'src'));
    writeFileSync(resolve(pluginDir, 'src/index.ts'), 'export {}');

    expect(readManifest(pluginDir)).toEqual({
      manifest: expect.objectContaining({name: 'source-entry-plugin'}),
      path: resolve(pluginDir, 'manifest.json'),
      warnings: [],
    });
  });

  test('returns validated fixture manifest and absolute manifest path', () => {
    const pluginDir = resolve(import.meta.dirname, '../../../plugins/builtin/clock-widget');

    expect(readManifest(pluginDir)).toEqual({
      manifest: expect.objectContaining({name: 'clock-widget'}),
      path: resolve(pluginDir, 'manifest.json'),
      warnings: [],
    });
  });
});

describe('unknownManifestKeys', () => {
  test('warns once per unknown top-level key', () => {
    expect(unknownManifestKeys({permision: []})).toEqual([
      'unknown manifest key "permision" is ignored',
    ]);
  });

  test('does not warn about $schema', () => {
    expect(unknownManifestKeys({$schema: 'https://example.test/manifest.schema.json'})).toEqual([]);
  });

  test('does not warn for every key of valid widget and page manifests', () => {
    for (const filename of ['widget-minimal.json', 'page-minimal.json']) {
      const fixturePath = resolve(import.meta.dirname, `../../../contracts/manifest/fixtures/valid/${filename}`);
      const manifest = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

      expect(unknownManifestKeys(manifest)).toEqual([]);
    }
  });
});
