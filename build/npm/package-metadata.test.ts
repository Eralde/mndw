import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {PUBLISHED_PACKAGES} from './pack-all.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('published npm package metadata', () => {
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
