import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

import {describe, expect, it} from 'vitest';

const tarball = process.env.MNDW_CLI_TARBALL;
const cliRoot = resolve(import.meta.dirname, '..');

function templateFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      return templateFiles(absolute, path);
    }

    return entry.isFile() ? [path] : [];
  });
}

function listTarballFiles(path: string): string[] {
  const result = spawnSync('tar', ['-tzf', path], {encoding: 'utf8'});

  if (result.status !== 0) {
    throw new Error(`Could not list CLI tarball: ${result.stderr}`);
  }

  return result.stdout.split('\n').filter(Boolean);
}

function requireTarball(): string {
  if (tarball === undefined) {
    throw new Error('MNDW_CLI_TARBALL is required for this test');
  }

  return tarball;
}

describe.skipIf(tarball === undefined)('CLI tarball', () => {
  it('contains the complete template tree under package/templates', () => {
    const packageTarball = requireTarball();
    const expected = templateFiles(resolve(cliRoot, 'templates')).sort();
    const actual = listTarballFiles(packageTarball)
      .filter((path) => path.startsWith('package/templates/') && !path.endsWith('/'))
      .map((path) => path.slice('package/templates/'.length))
      .sort();

    expect(actual).toEqual(expected);
  });

  it('ships the executable CLI bundle and prebuilt dev host', () => {
    const packageTarball = requireTarball();
    const bundle = spawnSync('tar', ['-xOf', packageTarball, 'package/dist/mndw.js'], {encoding: 'utf8'});
    const hostIndex = listTarballFiles(packageTarball);

    expect(bundle.status).toBe(0);
    expect(bundle.stdout.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(hostIndex).toContain('package/host-dev/index.html');
  });
});
