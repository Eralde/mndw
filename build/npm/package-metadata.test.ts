import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {SDK_VERSION} from '../../frontend/sdk/src/version.js';
import {SHARED_DEPENDENCIES} from '../../frontend/sdk-internal/src/shared-dependencies.js';
import {PUBLISHED_PACKAGES} from './pack-all.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('published npm package metadata', () => {
  it('keeps every published package and SDK runtime version aligned with the root release', () => {
    const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {version?: string};
    const releaseVersion = rootManifest.version;

    for (const {name, relativeDir} of PUBLISHED_PACKAGES) {
      const manifest = JSON.parse(readFileSync(join(repositoryRoot, relativeDir, 'package.json'), 'utf8')) as {
        version?: string;
      };

      expect(manifest.version, `${name} version`).toBe(releaseVersion);
    }

    expect(SDK_VERSION).toBe(releaseVersion);

    const uiDependency = SHARED_DEPENDENCIES.find((dependency) => dependency.specifiers.includes('@mndw/ui'));

    expect(uiDependency?.version).toBe(releaseVersion);
  });

  it.each(PUBLISHED_PACKAGES)('$name declares complete release metadata', ({relativeDir}) => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, relativeDir, 'package.json'), 'utf8')) as {
      license?: unknown;
      homepage?: unknown;
      repository?: unknown;
    };

    expect(manifest.license).toBe('MIT');
    expect(manifest.homepage).toBe('https://eralde.github.io/mndw/');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Eralde/mndw.git',
      directory: relativeDir,
    });
  });
});
