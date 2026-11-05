import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unzipSync} from 'fflate';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {zipDirectory, zipPlugin} from './zip.js';

function widgetManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
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

function findCentralDirectoryEntry(archive: Uint8Array, name: string): DataView {
  const archiveView = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();

  for (let offset = archive.byteLength - 22; offset >= 0; offset--) {
    if (archiveView.getUint32(offset, true) !== 0x02014b50) {
      continue;
    }

    const nameLength = archiveView.getUint16(offset + 28, true);
    const entryName = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));

    if (entryName === name) {
      return new DataView(archive.buffer, archive.byteOffset + offset, archive.byteLength - offset);
    }
  }

  throw new Error(`ZIP central directory entry not found: ${name}`);
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

  it('writes undeclared files as non-executable regardless of their filesystem mode', () => {
    const indexPath = join(dir, 'index.js');

    writeFileSync(indexPath, 'export {};');
    chmodSync(indexPath, 0o755);

    const entry = findCentralDirectoryEntry(zipDirectory(dir), 'index.js');

    expect(Math.floor(entry.getUint16(4, true) / 0x100)).toBe(3);
    expect(entry.getUint16(40, true) % 0o1000).toBe(0o644);
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

  it('forwards cross backend overrides and skips the host build hook', async () => {
    scaffold(dir, {
      ...widgetManifest({
        name: 'cross-zipped-widget',
        backend: {
          kind: 'service',
          protocolVersion: 1,
          command: 'backend/food',
          routes: [{id: 'food', transport: 'http', method: 'GET', path: 'food'}],
        },
      }),
    });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({mndw: {backendBuildScript: 'build-backend'}}));

    const sourceRoot = mkdtempSync(join(tmpdir(), 'mndw-zip-source-'));
    const binary = join(sourceRoot, 'food');

    writeFileSync(binary, 'target binary');

    const output = join(tmpdir(), 'mndw-cross.zip');
    const outDir = mkdtempSync(join(tmpdir(), 'mndw-zip-cross-out-'));
    const runHook = vi.fn(() => ({status: 0}));

    try {
      await zipPlugin(dir, {
        outDir,
        output,
        runBackendBuild: runHook,
        backendOverride: {
          target: 'aarch64',
          sourceRoot,
          files: [{source: binary, destination: 'backend/food'}],
        },
      });

      expect(runHook).not.toHaveBeenCalled();
      expect(Object.keys(unzipSync(readFileSync(output)))).toContain('backend/food');
    } finally {
      rmSync(sourceRoot, {recursive: true, force: true});
      rmSync(outDir, {recursive: true, force: true});
      rmSync(output, {force: true});
    }
  });

  it('marks a manifest service command executable with Unix host metadata', async () => {
    scaffold(
      dir,
      widgetManifest({
        backend: {
          kind: 'service',
          protocolVersion: 1,
          command: 'backend/main.sh',
          routes: [{id: 'hello', transport: 'http', method: 'GET', path: 'hello'}],
        },
      }),
    );
    mkdirSync(join(dir, 'backend'), {recursive: true});

    const backendPath = join(dir, 'backend', 'main.sh');

    writeFileSync(backendPath, '#!/bin/sh\n');
    chmodSync(backendPath, 0o644);

    const result = await zipPlugin(dir);
    const archive = readFileSync(result.outputPath);
    const entry = findCentralDirectoryEntry(archive, 'backend/main.sh');

    expect(Math.floor(entry.getUint16(4, true) / 0x100)).toBe(3);
    expect(entry.getUint16(40, true) % 0o1000).toBe(0o755);
  });

  it('marks a shared exec command executable when multiple routes reference it', async () => {
    scaffold(
      dir,
      widgetManifest({
        backend: {
          kind: 'exec',
          routes: [
            {id: 'first', transport: 'http', method: 'GET', path: 'first', command: 'backend/main.sh'},
            {id: 'second', transport: 'http', method: 'GET', path: 'second', command: 'backend/main.sh'},
          ],
        },
      }),
    );
    mkdirSync(join(dir, 'backend'), {recursive: true});

    const backendPath = join(dir, 'backend', 'main.sh');

    writeFileSync(backendPath, '#!/bin/sh\n');
    chmodSync(backendPath, 0o644);

    const result = await zipPlugin(dir);
    const entry = findCentralDirectoryEntry(readFileSync(result.outputPath), 'backend/main.sh');

    expect(entry.getUint16(40, true) % 0o1000).toBe(0o755);
  });
});
