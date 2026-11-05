import {describe, expect, it} from 'vitest';

import {selectTestScope} from './ci-test-scope';

const packageDirs = [
  'frontend/ui',
  'frontend/ui-svelte',
  'frontend/host',
  'build/palette',
  'build/npm/mndwd/linux-x64',
];

describe('selectTestScope', () => {
  it.each([
    {changedFiles: ['frontend/ui/src/a.ts'], expected: 'affected', name: 'selects an affected package file'},
    {
      changedFiles: ['frontend/ui-svelte/src/a.ts', 'frontend/host/src/b.ts'],
      expected: 'affected',
      name: 'selects files in multiple affected packages',
    },
    {changedFiles: ['frontend/uix/a.ts'], expected: 'full', name: 'does not match package path prefixes'},
    {changedFiles: ['pnpm-lock.yaml'], expected: 'full', name: 'uses full scope for the lockfile'},
    {changedFiles: ['package.json'], expected: 'full', name: 'uses full scope for the root manifest'},
    {changedFiles: ['build/targets.ts'], expected: 'full', name: 'uses full scope for build orchestration'},
    {changedFiles: ['build/npm/README.json'], expected: 'full', name: 'does not match the nested package parent'},
    {
      changedFiles: ['build/npm/mndwd/linux-x64/package.json'],
      expected: 'affected',
      name: 'matches a nested workspace package',
    },
    {changedFiles: ['contracts/tokens.json'], expected: 'full', name: 'uses full scope for contracts'},
    {changedFiles: ['.github/workflows/ci-ts.yml'], expected: 'full', name: 'uses full scope for CI workflows'},
    {
      changedFiles: ['docs/ai/testing.md', 'README.md', 'frontend/ui/CHANGELOG.md'],
      expected: 'affected',
      name: 'ignores documentation and Markdown files',
    },
    {changedFiles: ['docs/x.md', 'tsconfig.base.json'], expected: 'full', name: 'does not ignore non-Markdown files'},
    {changedFiles: [], expected: 'affected', name: 'uses affected scope when no files remain'},
  ])('$name', ({changedFiles, expected}) => {
    expect(selectTestScope(changedFiles, packageDirs)).toBe(expected);
  });
});
