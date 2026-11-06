import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {authorDocPages} from './markdown-blocks.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const extraFiles = [
  'docs/plugin-author/.vitepress/config.mts',
  'frontend/sdk/README.md',
  'frontend/ui/README.md',
  'frontend/ui-svelte/README.md',
  'frontend/ui-vue/README.md',
  'frontend/ui-angular/README.md',
  'tooling/palette-core/README.md',
  'tooling/cli/README.md',
  'build/npm/mndwd/mndwd-darwin-arm64/README.md',
  'build/npm/mndwd/mndwd-darwin-x64/README.md',
  'build/npm/mndwd/mndwd-linux-x64/README.md',
  'build/npm/mndwd/mndwd-linux-arm64/README.md',
  'build/npm/mndwd/mndwd-win32-x64/README.md',
  'README.md',
];

function repoFiles(): string[] {
  return [...authorDocPages(repoRoot), ...extraFiles];
}

function githubTargets(source: string): Array<{branch: string; path: string; kind: string}> {
  const targets: Array<{branch: string; path: string; kind: string}> = [];
  const expression = /https:\/\/github\.com\/Eralde\/mndw\/(blob|tree|edit)\/(main|master)\/([^\s"'<>)]*)/g;

  for (const match of source.matchAll(expression)) {
    const rawPath = match[3] ?? '';
    const path = rawPath.split(/[?#]/, 1)[0]?.replace(/[.,;:]+$/, '') ?? '';

    targets.push({
      branch: match[2] ?? '',
      kind: match[1] ?? '',
      path,
    });
  }

  return targets;
}

describe('repository links', () => {
  it('does not point at main', () => {
    const hits = repoFiles().flatMap((path) => {
      const source = readFileSync(resolve(repoRoot, path), 'utf8');

      return githubTargets(source)
        .filter((target) => target.branch === 'main')
        .map((target) => `${path}: ${target.kind}/main/${target.path}`);
    });

    expect(hits).toEqual([]);
  });

  it('uses existing paths for blob and tree links on master', () => {
    const missing = repoFiles().flatMap((path) => {
      const source = readFileSync(resolve(repoRoot, path), 'utf8');

      return githubTargets(source)
        .filter((target) => target.branch === 'master' && target.kind !== 'edit')
        .filter((target) => target.path.length > 0 && !existsSync(resolve(repoRoot, target.path)))
        .map((target) => `${path}: ${target.kind}/master/${target.path}`);
    });

    expect(missing).toEqual([]);
  });
});
