import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {MNDWD_PLATFORMS} from '../../tooling/cli/src/mndwd-platforms.js';
import {mndwdPackageJson} from './mndwd-packages.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packagesDir = join(repositoryRoot, 'build/npm/mndwd');
const cliPackage = JSON.parse(readFileSync(join(repositoryRoot, 'tooling/cli/package.json'), 'utf8')) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

describe('mndwd npm packages', () => {
  it('limits Windows x64 package to Windows x64 and ships bin', () => {
    const platform = MNDWD_PLATFORMS.find((entry) => entry.packageName === '@mndw/mndwd-win32-x64');

    expect(platform).toBeDefined();

    if (platform === undefined) {
      return;
    }

    expect(mndwdPackageJson(platform, cliPackage.version)).toMatchObject({
      os: ['win32'],
      cpu: ['x64'],
      files: ['bin'],
      bin: {mndwd: './bin/mndwd.exe'},
    });
  });

  it('keeps committed package metadata in sync with CLI version and platform table', () => {
    for (const platform of MNDWD_PLATFORMS) {
      const packageName = platform.packageName.split('/')[1];
      const packageJson = JSON.parse(readFileSync(join(packagesDir, packageName, 'package.json'), 'utf8')) as unknown;

      expect(packageJson).toEqual(mndwdPackageJson(platform, cliPackage.version));
    }
  });

  it('declares exactly the five platform packages as workspace optional dependencies', () => {
    expect(cliPackage.optionalDependencies).toEqual(Object.fromEntries(
      MNDWD_PLATFORMS.map((platform) => [platform.packageName, 'workspace:*']),
    ));
  });
});
