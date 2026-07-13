import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {detectFramework} from './framework.js';

describe('detectFramework', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mndw-framework-'));
    mkdirSync(join(dir, 'src'), {recursive: true});
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('detects vanilla for a plain typescript source tree', () => {
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const createInstance = () => ({});\n');

    expect(detectFramework(dir)).toBe('vanilla');
  });

  it('detects svelte when the source tree contains a .svelte file', () => {
    writeFileSync(join(dir, 'src', 'index.ts'), 'import App from "./App.svelte";\n');
    writeFileSync(join(dir, 'src', 'App.svelte'), '<h1>hi</h1>\n');

    expect(detectFramework(dir)).toBe('svelte');
  });

  it('detects svelte for a nested .svelte component', () => {
    mkdirSync(join(dir, 'src', 'components'), {recursive: true});
    writeFileSync(join(dir, 'src', 'index.ts'), 'import Foo from "./components/Foo.svelte";\n');
    writeFileSync(join(dir, 'src', 'components', 'Foo.svelte'), '<p>foo</p>\n');

    expect(detectFramework(dir)).toBe('svelte');
  });
});
