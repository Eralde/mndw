import {readdirSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';

export type DocsDirective =
  | {kind: 'file'; path: string}
  | {kind: 'skip'}
  | {kind: 'scaffold'; args: string[]};

export interface FencedBlock {
  readonly page: string;
  readonly line: number;
  readonly lang: string;
  readonly code: string;
  readonly directive?: DocsDirective;
}

interface FenceOpen {
  readonly character: '`' | '~';
  readonly length: number;
  readonly info: string;
}

function openingFence(line: string): FenceOpen | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

  if (match === null) {
    return undefined;
  }

  const token = match[1] ?? '';

  return {
    character: token[0] as '`' | '~',
    length: token.length,
    info: (match[2] ?? '').trim(),
  };
}

function isClosingFence(line: string, fence: FenceOpen): boolean {
  const expression = new RegExp(`^ {0,3}${fence.character === '`' ? '`' : '~'}{${fence.length},}\\s*$`);

  return expression.test(line);
}

function parseShellArgs(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '\'' | '"' | undefined;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== '"') {
      escaped = true;
    } else if (quote !== undefined && character === quote) {
      quote = undefined;
    } else if (quote === undefined && (character === '\'' || character === '"')) {
      quote = character;
    } else if (quote === undefined && /\s/.test(character)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }

  if (escaped) {
    current += '\\';
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function parseDirective(page: string, lineNumber: number, line: string): DocsDirective | undefined {
  const trimmed = line.trim();

  if (!trimmed.startsWith('<!-- docs-check:')) {
    return undefined;
  }

  const match = /^<!--\s*docs-check:\s*(.*?)\s*-->$/.exec(trimmed);
  const value = match?.[1] ?? '';
  const [kind, ...rest] = value.split(/\s+/).filter((part) => part.length > 0);

  if (kind === 'skip' && rest.length === 0) {
    return {kind: 'skip'};
  }

  if (kind === 'file' && rest.length === 1) {
    return {kind: 'file', path: rest[0] ?? ''};
  }

  if (kind === 'scaffold' && rest.length > 0) {
    return {kind: 'scaffold', args: parseShellArgs(rest.join(' '))};
  }

  throw new Error(`${page}:${lineNumber}: unknown docs-check directive`);
}

export function readFencedBlocks(page: string, markdown: string): FencedBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: FencedBlock[] = [];
  let pendingDirective: DocsDirective | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = openingFence(line);

    if (fence !== undefined) {
      const code: string[] = [];
      let closingIndex = index + 1;

      while (closingIndex < lines.length && !isClosingFence(lines[closingIndex] ?? '', fence)) {
        code.push(lines[closingIndex] ?? '');
        closingIndex += 1;
      }

      const block: FencedBlock = {
        page,
        line: index + 1,
        lang: fence.info.split(/\s+/)[0] ?? '',
        code: code.length > 0 ? `${code.join('\n')}\n` : '',
        ...(pendingDirective === undefined ? {} : {directive: pendingDirective}),
      };

      blocks.push(block);
      pendingDirective = undefined;
      index = closingIndex < lines.length ? closingIndex : lines.length;
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    pendingDirective = parseDirective(page, index + 1, line);
  }

  return blocks;
}

export function authorDocPages(repoRoot: string): string[] {
  const docsRoot = resolve(repoRoot, 'docs/plugin-author');
  const pages: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (relative(docsRoot, absolute).split(sep)[0] !== 'api') {
          visit(absolute);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        pages.push(
          relative(repoRoot, absolute).split(sep)
            .join('/'),
        );
      }
    }
  }

  visit(docsRoot);

  return pages.sort();
}

export function normalizeBlock(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
    .map((line) => line.replace(/[\t ]+$/g, ''));
  const normalized = lines.join('\n').replace(/\n+$/g, '');

  return `${normalized}\n`;
}
