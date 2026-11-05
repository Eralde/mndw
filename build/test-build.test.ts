import {readdirSync, readFileSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {describe, expect, it} from 'vitest';
import {BUILD_NODE_FILES, BUILD_VITEST_FILES} from './scripts/run-build-tests.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BUILD_ROOT = join(REPO_ROOT, 'build');
const EXCLUDED_PREFIXES = ['docs/', 'npm/', 'palette/'];
const EXCLUDED_FILES = new Set(['scripts/audit-px.test.ts']);

function discoverBuildTests(relativeDirectory = ''): string[] {
  const directory = join(BUILD_ROOT, relativeDirectory);

  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    if (entry.name === '.nocommit' || entry.name === 'node_modules') {
      return [];
    }

    const relativePath = join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      return discoverBuildTests(relativePath);
    }

    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) {
      return [];
    }

    const normalizedPath = relative(BUILD_ROOT, join(BUILD_ROOT, relativePath)).split(sep).join('/');

    if (EXCLUDED_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix)) || EXCLUDED_FILES.has(normalizedPath)) {
      return [];
    }

    return [`build/${normalizedPath}`];
  });
}

describe('build test runner inventory', () => {
  it('lists every eligible build test exactly once', () => {
    const discovered = discoverBuildTests().sort();
    const listed = [...BUILD_VITEST_FILES, ...BUILD_NODE_FILES];

    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(discovered);
  });

  it('keeps the Vitest and Node lists disjoint', () => {
    expect(BUILD_VITEST_FILES.filter((file) => BUILD_NODE_FILES.includes(file))).toEqual([]);
  });

  it('routes Vitest files and Node assertion scripts to the matching runner', () => {
    for (const file of BUILD_VITEST_FILES) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8'), file).toMatch(/from\s+['"]vitest['"]/);
    }

    for (const file of BUILD_NODE_FILES) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8'), file).not.toMatch(/from\s+['"]vitest['"]/);
    }
  });
});
