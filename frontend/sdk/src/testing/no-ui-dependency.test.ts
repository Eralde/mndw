import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(full);
    }

    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

// Matches the quoted @mndw/ui module specifier regardless of import syntax
// (static `from`, side-effect `import '…'`, or dynamic `import('…')`).
const UI_IMPORT = /import\s*(?:[^'"]*\bfrom\s*)?\(?\s*['"]@mndw\/ui(?:\/[^'"]*)?['"]/;

describe('sdk/testing dependency invariant', () => {
  it('imports nothing from @mndw/ui', () => {
    const offenders = sourceFiles(import.meta.dirname).filter((file) => UI_IMPORT.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
