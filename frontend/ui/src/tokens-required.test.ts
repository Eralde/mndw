import {readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {TOKENS_REQUIRED} from './tokens-required.js';

const TOKEN_REFERENCE = /var\(\s*(--mndw-[a-z0-9-]+)([^)]*)\)/g;

interface SourceFile {
  path: string;
  url: URL;
}

async function sourceFiles(directory: string): Promise<SourceFile[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files: SourceFile[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    const url = pathToFileURL(path);

    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.css')) && !entry.name.endsWith('.test.ts')) {
      files.push({path: url.pathname, url});
    }
  }

  return files;
}

describe('TOKENS_REQUIRED', () => {
  it('declares every token used by shipped UI source without fallbacks', async () => {
    const files = await sourceFiles(resolve(process.cwd(), 'src'));
    const references = new Map<string, string[]>();

    for (const file of files) {
      const source = await readFile(file.url, 'utf8');

      for (const match of source.matchAll(TOKEN_REFERENCE)) {
        const token = match[1];
        const details = match[2];
        const locations = references.get(token) ?? [];

        locations.push(file.path);
        references.set(token, locations);
        expect(details, `${token} in ${file.path}`).not.toContain(',');
      }
    }

    const required = new Set<string>(TOKENS_REQUIRED);
    const undeclared = [...references.keys()].filter((token) => !required.has(token));

    expect(undeclared).toEqual([]);
    expect(TOKENS_REQUIRED.length).toBeGreaterThan(0);
  });
});
