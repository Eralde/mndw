import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {MNDWD_PLATFORMS} from '../../tooling/cli/src/mndwd-platforms.js';
import {mndwdPackageJson, writeMndwdPackageManifests} from './mndwd-packages.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packagesDir = join(repositoryRoot, 'build/npm/mndwd');
const cliPackage = JSON.parse(readFileSync(join(repositoryRoot, 'tooling/cli/package.json'), 'utf8')) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

describe('mndwd npm packages', () => {
  it('declares release metadata and the repository directory for every platform', () => {
    for (const platform of MNDWD_PLATFORMS) {
      const packageName = platform.packageName.replace('@mndw/', '');

      expect(mndwdPackageJson(platform, cliPackage.version)).toMatchObject({
        license: 'MIT',
        homepage: 'https://eralde.github.io/mndw/',
        repository: {
          type: 'git',
          url: 'git+https://github.com/Eralde/mndw.git',
          directory: `build/npm/mndwd/${packageName}`,
        },
      });
    }
  });

  it('limits Windows x64 package to Windows x64 and ships bin', () => {
    const platform = MNDWD_PLATFORMS.find((entry) => entry.packageName === '@mndw/mndwd-win32-x64');

    expect(platform).toBeDefined();

    if (platform === undefined) {
      return;
    }

    const packageJson = mndwdPackageJson(platform, cliPackage.version);

    expect(packageJson).toMatchObject({
      publishConfig: {os: ['win32'], cpu: ['x64']},
      files: ['bin'],
      bin: {mndwd: './bin/mndwd.exe'},
    });
    // pnpm warns about every workspace package with a foreign os/cpu; publishConfig applies them only when packed.
    expect(packageJson).not.toHaveProperty('os');
    expect(packageJson).not.toHaveProperty('cpu');
  });

  it('keeps committed package metadata in sync with CLI version and platform table', () => {
    for (const platform of MNDWD_PLATFORMS) {
      const packageName = platform.packageName.split('/')[1];
      const packageJson = JSON.parse(readFileSync(join(packagesDir, packageName, 'package.json'), 'utf8')) as unknown;

      expect(packageJson).toEqual(mndwdPackageJson(platform, cliPackage.version));
    }
  });

  it('generates README and matching description for every platform package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mndw-mndwd-readmes-'));

    try {
      writeMndwdPackageManifests({version: cliPackage.version, packagesDir: directory});

      for (const platform of MNDWD_PLATFORMS) {
        const packageName = platform.packageName.split('/')[1];
        const generatedDir = join(directory, packageName);
        const metadata = JSON.parse(await readFile(join(generatedDir, 'package.json'), 'utf8')) as {
          description: string;
        };
        const readme = await readFile(join(generatedDir, 'README.md'), 'utf8');
        expect(readme.split('\n')[0]).toBe(`# ${platform.packageName}`);
        expect(readme.split('\n\n')[1]).toBe(metadata.description);
        expect(readme).toContain('https://eralde.github.io/mndw/');
        expect(readme).toContain('Installed automatically by `@mndw/cli`');
      }
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('declares exactly the five platform packages as workspace optional dependencies', () => {
    expect(cliPackage.optionalDependencies).toEqual(Object.fromEntries(
      MNDWD_PLATFORMS.map((platform) => [platform.packageName, 'workspace:*']),
    ));
  });
});
