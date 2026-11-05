import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {createProgram} from '../../tooling/cli/src/index.js';

import {authorDocPages, readFencedBlocks} from './markdown-blocks.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function treePaths(tree: string): string[] {
  const paths: string[] = [];
  const parents: string[] = [];

  for (const line of tree.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      continue;
    }

    const indentation = line.match(/^ */)?.[0].length ?? 0;

    if (indentation % 2 !== 0) {
      throw new Error(`Tree indentation must use two spaces: ${line}`);
    }

    const depth = indentation / 2;
    const entry = line.trim().replace(/\s+#.*$/, '');
    const isDirectory = entry.endsWith('/');
    const name = isDirectory ? entry.slice(0, -1) : entry;

    parents.length = depth;

    const path = [...parents, name].join('/');

    if (!isDirectory) {
      paths.push(path);
    } else {
      parents.push(name);
    }
  }

  return paths.sort();
}

function generatedPaths(directory: string): string[] {
  const paths: string[] = [];

  function visit(current: string, prefix: string): void {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      if (['node_modules', 'dist'].includes(entry.name)) {
        continue;
      }

      const path = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        visit(resolve(current, entry.name), path);
      } else if (
        entry.isFile()
        && !['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'].includes(entry.name)
      ) {
        paths.push(path);
      }
    }
  }

  visit(directory, '');

  return paths.sort();
}

describe('scaffold tree blocks', () => {
  it('parses two-space directory trees and ignores comments', () => {
    expect(treePaths('# generated files\ndemo/\n  src/\n    main.ts\n  package.json\n')).toEqual([
      'demo/package.json',
      'demo/src/main.ts',
    ]);
  });

  it('matches every scaffold tree to real CLI output', async () => {
    const pages = authorDocPages(repoRoot);
    const failures: string[] = [];

    for (const page of pages) {
      const markdown = readFileSync(resolve(repoRoot, page), 'utf8');
      const blocks = readFencedBlocks(page, markdown);

      for (const block of blocks) {
        if (block.directive?.kind !== 'scaffold') {
          continue;
        }

        const name = block.directive.args[0];

        if (name === undefined || name.startsWith('-')) {
          failures.push(`${page}:${block.line}: scaffold directive must start with project name`);
          continue;
        }

        const tempRoot = mkdtempSync(resolve(tmpdir(), 'mndw-docs-scaffold-'));
        const outputDir = resolve(tempRoot, name);

        try {
          await createProgram().parseAsync(
            ['node', 'mndw', 'create', ...block.directive.args, '--out', outputDir, '--no-install'],
            {from: 'node'},
          );
          expect(generatedPaths(tempRoot)).toEqual(treePaths(block.code));
        } catch (error) {
          failures.push(`${page}:${block.line}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          rmSync(tempRoot, {recursive: true, force: true});
        }
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);
});
