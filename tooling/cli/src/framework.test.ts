import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {CliError} from './errors.js';
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

  it('detects vue when the source tree contains a .vue file', () => {
    writeFileSync(join(dir, 'src', 'App.vue'), '<template><b/></template>\n');

    expect(detectFramework(dir)).toBe('vue');
  });

  it('throws on a mixed .vue + .svelte source tree', () => {
    writeFileSync(join(dir, 'src', 'App.vue'), '<template/>\n');
    writeFileSync(join(dir, 'src', 'Other.svelte'), '<b/>\n');

    expect(() => detectFramework(dir)).toThrow(CliError);
  });

  describe('angular', () => {
    it('detects angular from a root tsconfig.json with angularCompilerOptions', () => {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({compilerOptions: {}, angularCompilerOptions: {}}),
      );
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const createInstance = () => ({unmount() {}});');

      expect(detectFramework(dir)).toBe('angular');
    });

    it('throws on a malformed root tsconfig.json', () => {
      writeFileSync(join(dir, 'tsconfig.json'), '{ not json');

      expect(() => detectFramework(dir)).toThrow(CliError);
    });

    it('throws on mixed angular + vue signals', () => {
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({angularCompilerOptions: {}}));
      writeFileSync(join(dir, 'src', 'App.vue'), '<template/>');

      expect(() => detectFramework(dir)).toThrow(CliError);
    });
  });
});
