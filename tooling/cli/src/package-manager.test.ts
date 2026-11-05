import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {detectPackageManager} from './package-manager.js';

describe('detectPackageManager', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it.each(
    [
      ['pnpm/10.0.0 npm/? node/v22.0.0', 'pnpm'],
      ['npm/10.0.0 node/v22.0.0', 'npm'],
      ['yarn/4.0.0 npm/? node/v22.0.0', 'yarn'],
      ['bun/1.0.0 npm/? node/v22.0.0', 'bun'],
    ] as const,
  )('uses the invoking package manager in %s', (userAgent, expected) => {
    expect(detectPackageManager({env: {npm_config_user_agent: userAgent}, cwd: '/missing'})).toBe(expected);
  });

  it.each(
    [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ] as const,
  )('detects %s in the nearest project', (lockfile, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'mndw-package-manager-'));

    roots.push(root);

    const nested = join(root, 'app', 'nested');

    mkdirSync(nested, {recursive: true});
    writeFileSync(join(root, 'app', lockfile), '');

    expect(detectPackageManager({env: {}, cwd: nested})).toBe(expected);
  });

  it('prefers the nearest lockfile while walking up', () => {
    const root = mkdtempSync(join(tmpdir(), 'mndw-package-manager-'));

    roots.push(root);

    const nested = join(root, 'app', 'nested');

    mkdirSync(nested, {recursive: true});
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    writeFileSync(join(root, 'app', 'yarn.lock'), '');

    expect(detectPackageManager({env: {}, cwd: nested})).toBe('yarn');
  });

  it('defaults to npm when no user agent or lockfile exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'mndw-package-manager-'));

    roots.push(root);

    expect(detectPackageManager({env: {}, cwd: root})).toBe('npm');
  });
});
