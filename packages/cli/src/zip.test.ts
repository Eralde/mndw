import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unzipSync} from 'fflate';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {zipDirectory, zipPlugin} from './zip.js';

function widgetManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    name: 'sample-widget',
    version: '0.1.0',
    type: 'widget',
    label: 'Sample',
    entry: 'index.js',
    size: {w: 3, h: 2},
    ...overrides,
  };
}

function scaffold(dir: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  mkdirSync(join(dir, 'src'), {recursive: true});
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const createInstance = () => ({unmount() {}});\n');
}

describe('zipDirectory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mndw-zipdir-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('archives directory contents at the root and excludes hidden files', () => {
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'index.js'), 'export {};');
    writeFileSync(join(dir, '.DS_Store'), 'junk');
    writeFileSync(join(dir, '.hidden'), 'secret');
    mkdirSync(join(dir, 'backend'), {recursive: true});
    writeFileSync(join(dir, 'backend', 'server.sh'), '#!/bin/sh\n');

    const entries = unzipSync(zipDirectory(dir));
    const names = Object.keys(entries).sort();

    expect(names).toEqual(['backend/server.sh', 'index.js', 'manifest.json']);
    expect(names).not.toContain('.DS_Store');
  });
});

describe('zipPlugin', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mndw-zip-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('packs first, then writes a root-manifest archive readable by a zip reader', async () => {
    scaffold(dir, widgetManifest());

    const result = await zipPlugin(dir);

    expect(result.outputPath).toBe(join(dir, 'sample-widget.zip'));
    expect(existsSync(join(dir, 'dist'))).toBe(true);

    const entries = unzipSync(readFileSync(result.outputPath));
    const names = Object.keys(entries).sort();

    expect(names).toContain('manifest.json');
    expect(names).toContain('index.js');
    expect(names).toContain('mndw.lock.json');
    expect(names.some((name) => name.startsWith('dist/'))).toBe(false);
  });

  it('honors an explicit output path', async () => {
    scaffold(dir, widgetManifest({name: 'named-widget'}));

    const output = join(dir, 'artifacts', 'plugin.zip');

    const result = await zipPlugin(dir, {output});

    expect(result.outputPath).toBe(output);
    expect(existsSync(output)).toBe(true);
  });
});
