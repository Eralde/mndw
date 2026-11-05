import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {authorDocPages, normalizeBlock, readFencedBlocks} from './markdown-blocks.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('tutorial file blocks', () => {
  it('matches every joined file block to its repository file', () => {
    const pages = authorDocPages(repoRoot);
    const errors: string[] = [];

    for (const page of pages) {
      const markdown = readFileSync(resolve(repoRoot, page), 'utf8');
      const blocks = readFencedBlocks(page, markdown);
      const groups = new Map<string, string[]>();

      for (const block of blocks) {
        if (block.directive?.kind !== 'file') {
          continue;
        }

        const parts = groups.get(block.directive.path) ?? [];

        parts.push(block.code);
        groups.set(block.directive.path, parts);
      }

      for (const [path, parts] of groups) {
        const target = resolve(repoRoot, path);

        try {
          expect(normalizeBlock(parts.join('\n'))).toBe(normalizeBlock(readFileSync(target, 'utf8')));
        } catch (error) {
          errors.push(`${page}: ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    expect(errors).toEqual([]);
  });
});
