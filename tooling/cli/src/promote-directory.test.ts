import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const renameFailure = vi.hoisted(() => ({destination: undefined as string | undefined}));
const cleanupFailure = vi.hoisted(() => ({path: undefined as string | undefined}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  return {
    ...actual,
    renameSync: (source: string, destination: string): void => {
      if (destination === renameFailure.destination) {
        throw new Error('simulated backup rename failure');
      }

      actual.renameSync(source, destination);
    },
    rmSync: (path: string, options: {recursive?: boolean; force?: boolean}): void => {
      if (path === cleanupFailure.path) {
        throw new Error('simulated backup cleanup failure');
      }

      actual.rmSync(path, options);
    },
  };
});

import {promoteDirectory} from './promote-directory.js';

function makeDir(path: string, marker: string): void {
  mkdirSync(path, {recursive: true});
  writeFileSync(join(path, 'marker.txt'), marker);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mndw-promote-'));
});

afterEach(() => {
  renameFailure.destination = undefined;
  cleanupFailure.path = undefined;
  rmSync(root, {recursive: true, force: true});
});

describe('promoteDirectory promotion', () => {
  it('promotes into a missing destination and leaves no backup', () => {
    const source = join(root, 'staging');
    const destination = join(root, 'dist');

    makeDir(source, 'new');
    promoteDirectory(source, destination);

    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('new');
    expect(existsSync(source)).toBe(false);
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });

  it('removes a stale backup after promoting into a missing destination', () => {
    const source = join(root, 'staging');
    const destination = join(root, 'dist');

    makeDir(`${destination}.previous`, 'stale');
    makeDir(source, 'new');
    promoteDirectory(source, destination);

    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('new');
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });

  it('replaces an existing destination and removes the backup', () => {
    const source = join(root, 'staging');
    const destination = join(root, 'dist');

    makeDir(destination, 'old');
    makeDir(source, 'new');
    promoteDirectory(source, destination);

    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('new');
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });

  it('leaves both paths unchanged when backing up the destination fails', () => {
    const source = join(root, 'staging');
    const destination = join(root, 'dist');

    makeDir(destination, 'old');
    makeDir(source, 'new');
    renameFailure.destination = `${destination}.previous`;

    expect(() => promoteDirectory(source, destination)).toThrow('simulated backup rename failure');
    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'marker.txt'), 'utf8')).toBe('new');
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });

  it('clears a stale backup when the destination exists', () => {
    const source = join(root, 'staging');
    const destination = join(root, 'dist');

    makeDir(destination, 'old');
    makeDir(`${destination}.previous`, 'stale');
    makeDir(source, 'new');

    promoteDirectory(source, destination);

    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('new');
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });
});

describe('promoteDirectory rollback and cleanup', () => {
  it('keeps the new destination when backup cleanup fails', () => {
    const source = join(root, 'staging');
    const destination = join(root, 'dist');
    const backup = `${destination}.previous`;

    makeDir(destination, 'old');
    makeDir(source, 'new');
    cleanupFailure.path = backup;

    expect(() => promoteDirectory(source, destination)).toThrow('simulated backup cleanup failure');
    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(backup, 'marker.txt'), 'utf8')).toBe('old');
    expect(existsSync(source)).toBe(false);
  });

  it('restores a stale backup when the destination is missing and promotion fails', () => {
    const source = join(root, 'missing-staging');
    const destination = join(root, 'dist');
    const backup = `${destination}.previous`;

    makeDir(backup, 'recoverable');

    expect(() => promoteDirectory(source, destination)).toThrow();
    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('recoverable');
    expect(existsSync(backup)).toBe(false);
  });

  it('restores the original destination when promotion fails', () => {
    const source = join(root, 'missing-staging');
    const destination = join(root, 'dist');

    makeDir(destination, 'old');

    expect(() => promoteDirectory(source, destination)).toThrow();
    expect(readFileSync(join(destination, 'marker.txt'), 'utf8')).toBe('old');
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });

  it('rethrows without creating a backup when there is no existing destination', () => {
    const source = join(root, 'missing-staging');
    const destination = join(root, 'dist');

    expect(() => promoteDirectory(source, destination)).toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.previous`)).toBe(false);
  });
});
