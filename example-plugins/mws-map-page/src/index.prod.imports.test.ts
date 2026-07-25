import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';

import {describe, expect, it} from 'vitest';

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

function moduleFile(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.split('?')[0]);

  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function walkFrom(entry: string): Set<string> {
  const graph = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined || graph.has(current)) {
      continue;
    }

    graph.add(current);

    const source = readFileSync(current, 'utf8');

    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const target = moduleFile(current, match[1]);

      if (target !== null && !graph.has(target)) {
        pending.push(target);
      }
    }
  }

  return graph;
}

describe('production entry import graph', () => {
  it('never reaches mock or test-support modules from the production entry', () => {
    const graph = walkFrom(resolve(import.meta.dirname, 'index.prod.ts'));
    const offenders = [...graph].filter((file) =>
      file.includes(`${sep}mock${sep}`)
      || file.includes(`${sep}test-support${sep}`)
      || file.endsWith('mws-mock-data.service.ts')
    );

    expect(graph.has(resolve(import.meta.dirname, 'mws-map-instance.ts'))).toBe(true);
    expect(graph.has(resolve(import.meta.dirname, 'services/mws-data.service.ts'))).toBe(true);
    expect(offenders).toEqual([]);
  });
});
