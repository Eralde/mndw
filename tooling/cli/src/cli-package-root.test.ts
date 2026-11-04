import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {cliPackageRoot} from './cli-package-root.js';

describe('cliPackageRoot', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, {recursive: true, force: true});
      root = undefined;
    }
  });

  it('walks to the CLI package and skips an intervening package with a different name', () => {
    root = mkdtempSync(join(tmpdir(), 'mndw-cli-package-root-'));

    const cliRoot = join(root, 'x', 'node_modules', '@mndw', 'cli');
    const nestedPackage = join(cliRoot, 'node_modules', 'other-package');
    const dist = join(cliRoot, 'dist');

    mkdirSync(nestedPackage, {recursive: true});
    mkdirSync(dist, {recursive: true});
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({name: '@mndw/cli'}));
    writeFileSync(join(nestedPackage, 'package.json'), JSON.stringify({name: 'not-the-cli'}));

    expect(cliPackageRoot(dist)).toBe(cliRoot);
  });

  it('throws when no @mndw/cli package exists above the start directory', () => {
    const startDir = mkdtempSync(join(tmpdir(), 'mndw-no-cli-package-root-'));

    root = startDir;

    expect(() => cliPackageRoot(startDir)).toThrow('Could not locate @mndw/cli package root');
  });
});
