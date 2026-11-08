import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const serviceDirectory = dirname(fileURLToPath(import.meta.url));
const excludedFiles = new Set(['rest.ts', 'csrf.ts']);

describe('REST CSRF ownership', () => {
  it('keeps CSRF wiring inside rest.ts, except the specialized persistent session service', () => {
    const files = readdirSync(serviceDirectory)
      .filter((file) => file.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(file) && !excludedFiles.has(file));

    for (const file of files) {
      const source = readFileSync(join(serviceDirectory, file), 'utf8');

      // This service owns custom session response validation and stays outside the REST-client migration scope.
      if (file === 'persistent-rci-session.service.ts') {
        expect(source).toMatch(/\bCSRF_HEADERS\b/);
        continue;
      }

      expect(source, file).not.toMatch(/\bCSRF_HEADERS\b|['"]X-Mndw-Csrf['"]/);
    }
  });
});
