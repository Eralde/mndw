import {describe, expect, it} from 'vitest';

import {normalizeBlock, readFencedBlocks} from './markdown-blocks.js';

describe('readFencedBlocks', () => {
  it('records language, opening line and code', () => {
    const blocks = readFencedBlocks('docs/example.md', '# Example\n\n```ts title="Example"\nconst value = 1;\n```\n');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      page: 'docs/example.md',
      line: 3,
      lang: 'ts',
      code: 'const value = 1;\n',
    });
  });

  it('applies each directive only to the next block', () => {
    const markdown = [
      '<!-- docs-check: skip -->',
      '```ts',
      'const fragment = 1;',
      '```',
      '```ts',
      'const checked = 2;',
      '```',
    ].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks[0]?.directive).toEqual({kind: 'skip'});
    expect(blocks[1]?.directive).toBeUndefined();
  });

  it('parses file and scaffold directives', () => {
    const markdown = [
      '<!-- docs-check: file src/App.ts -->',
      '```ts',
      'export const app = true;',
      '```',
      '<!-- docs-check: scaffold --framework svelte --type widget -->',
      '```text',
      'demo/',
      '```',
    ].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks[0]?.directive).toEqual({kind: 'file', path: 'src/App.ts'});
    expect(blocks[1]?.directive).toEqual({kind: 'scaffold', args: ['--framework', 'svelte', '--type', 'widget']});
  });

  it('keeps consecutive file blocks as separate blocks with the same directive', () => {
    const markdown = [
      '<!-- docs-check: file src/App.svelte -->',
      '```svelte',
      '<script lang="ts">',
      '```',
      '<!-- docs-check: file src/App.svelte -->',
      '```svelte',
      '</script>',
      '```',
    ].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks.map((block) => block.directive)).toEqual([
      {kind: 'file', path: 'src/App.svelte'},
      {kind: 'file', path: 'src/App.svelte'},
    ]);
  });

  it('supports tilde fences and blocks inside a code group', () => {
    const markdown = ['::: code-group', '~~~ts [TypeScript]', 'const grouped = true;', '~~~', ':::'].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe('ts');
    expect(blocks[0]?.code).toBe('const grouped = true;\n');
  });

  it('applies a directive to a block inside a details container', () => {
    const markdown = [
      '::: details Complete src/App.svelte',
      '<!-- docs-check: file src/App.svelte -->',
      '```svelte',
      '<script lang="ts">',
      '  export let value: string;',
      '</script>',
      '```',
      ':::',
    ].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks[0]?.directive).toEqual({kind: 'file', path: 'src/App.svelte'});
  });

  it('treats a longer backtick fence containing a shorter fence as one block', () => {
    const markdown = ['````md', '```ts', 'const nested = true;', '```', '````'].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe('md');
    expect(blocks[0]?.code).toBe('```ts\nconst nested = true;\n```\n');
  });

  it('treats a longer tilde fence containing a backtick fence as one block', () => {
    const markdown = ['~~~~md', '```ts', 'const nested = true;', '```', '~~~~'].join('\n');
    const blocks = readFencedBlocks('docs/example.md', markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('```ts\nconst nested = true;\n```\n');
  });

  it('throws for an unknown docs-check directive with page and line', () => {
    expect(() => readFencedBlocks('docs/example.md', '<!-- docs-check: typo -->\n```ts\nx\n```'))
      .toThrow('docs/example.md:1');
  });
});

describe('normalizeBlock', () => {
  it('normalizes CRLF, trailing spaces and the final newline', () => {
    expect(normalizeBlock('first  \r\nsecond\t')).toBe('first\nsecond\n');
  });
});
