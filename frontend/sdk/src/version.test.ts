import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {SDK_VERSION} from './version.js';

describe('SDK_VERSION', () => {
  it('matches the package.json version', () => {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as {version: string};

    expect(SDK_VERSION).toBe(pkg.version);
  });
});
