import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {compileAngular} from './angular-compiler.js';
import {CliError} from './errors.js';

function ngPlugin(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mndw-ng-'));

  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);

    mkdirSync(join(full, '..'), {recursive: true});
    writeFileSync(full, contents);
  }

  return dir;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    experimentalDecorators: true,
    useDefineForClassFields: false,
    outDir: '.ngc-cache',
    rootDir: 'src',
  },
  angularCompilerOptions: {strictInjectionParameters: true},
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts', 'src/**/test-support/**/*.ts', 'src/**/fixtures/**/*.ts'],
});

const INDEX = 'import {AppComponent} from "./app.component";\nexport {AppComponent};\n';
const COMPONENT = 'import {Component} from "@angular/core";\n'
  + '@Component({selector: "x-root", standalone: true, template: "<b></b>", styleUrls: ["./x.component.scss"]})\n'
  + 'export class AppComponent {}\n';

describe('compileAngular validation', () => {
  it('throws when tsconfig.json is missing', () => {
    const dir = ngPlugin({'src/index.ts': INDEX});

    expect(() => compileAngular(dir)).toThrow(CliError);
    rmSync(dir, {recursive: true, force: true});
  });

  it('throws when angularCompilerOptions is absent', () => {
    const dir = ngPlugin({'tsconfig.json': '{"compilerOptions":{}}', 'src/index.ts': INDEX});

    expect(() => compileAngular(dir)).toThrow(CliError);
    rmSync(dir, {recursive: true, force: true});
  });

  it('throws when tsconfig has extends', () => {
    const ts = JSON.stringify({extends: './base.json', angularCompilerOptions: {}});
    const dir = ngPlugin({'tsconfig.json': ts, 'src/index.ts': INDEX});

    expect(() => compileAngular(dir)).toThrow(/extends/);
    rmSync(dir, {recursive: true, force: true});
  });

  it('throws when src is missing', () => {
    const dir = ngPlugin({'tsconfig.json': TSCONFIG});

    expect(() => compileAngular(dir)).toThrow(/missing src/);
    rmSync(dir, {recursive: true, force: true});
  });

  it('throws when include points outside src', () => {
    const ts = JSON.stringify({angularCompilerOptions: {}, include: ['../shared/**/*.ts']});
    const dir = ngPlugin({'tsconfig.json': ts, 'src/index.ts': INDEX});

    expect(() => compileAngular(dir)).toThrow(/within src/);
    rmSync(dir, {recursive: true, force: true});
  });
});

describe('compileAngular happy path', () => {
  it('sass-compiles styleUrls, runs ngc, and does not mutate the source', () => {
    const dir = ngPlugin({
      'tsconfig.json': TSCONFIG,
      'src/index.ts': INDEX,
      'src/app.component.ts': COMPONENT,
      'src/x.component.scss': '.a{.b{color:red}}',
    });

    const result = compileAngular(dir);

    expect(existsSync(result.entryPath)).toBe(true);
    expect(result.entryPath.endsWith('index.js')).toBe(true);
    expect(readdirSync(join(dir, 'src')).some((file) => file.endsWith('.css'))).toBe(false);
    expect(readFileSync(join(dir, 'src', 'app.component.ts'), 'utf8')).toContain('.scss');

    result.cleanup();
    expect(existsSync(result.cacheDir)).toBe(false);
    rmSync(dir, {recursive: true, force: true});
  });

  it('returns the selected compiled source entry', () => {
    const dir = ngPlugin({
      'tsconfig.json': TSCONFIG,
      'src/index.ts': 'export {}',
      'src/index.prod.ts': 'export {}',
    });

    const result = compileAngular(dir, 'src/index.prod.ts');

    expect(result.entryPath.endsWith('index.prod.js')).toBe(true);

    result.cleanup();
    rmSync(dir, {recursive: true, force: true});
  });

  it('excludes test-only sources from production compilation', () => {
    const dir = ngPlugin({
      'tsconfig.json': TSCONFIG,
      'src/index.ts': INDEX,
      'src/app.component.ts': COMPONENT,
      'src/x.component.scss': '.a{.b{color:red}}',
      'src/ignored.test.ts': 'const invalid: string = 42;\n',
      'src/test-support/ignored.ts': 'const invalid: string = 42;\n',
      'src/fixtures/ignored.ts': 'const invalid: string = 42;\n',
    });

    const result = compileAngular(dir);

    expect(result.entryPath.endsWith('index.js')).toBe(true);

    result.cleanup();
    rmSync(dir, {recursive: true, force: true});
  });

  it('throws when selected source entry was not emitted by ngc', () => {
    const tsconfig = JSON.stringify({...JSON.parse(TSCONFIG), include: ['src/index.ts']});
    const dir = ngPlugin({
      'tsconfig.json': tsconfig,
      'src/index.ts': 'export {}',
      'src/index.prod.ts': 'export {}',
    });

    expect(() => compileAngular(dir, 'src/index.prod.ts')).toThrow(/index\.prod\.ts/);

    rmSync(dir, {recursive: true, force: true});
  });
});

describe('compileAngular SDK subpaths', () => {
  it('resolves SDK subpath imports through the staged compiler', () => {
    const dir = ngPlugin({
      'tsconfig.json': TSCONFIG,
      'src/index.ts': 'import type {RrdTick} from "@mndw/sdk/rrd";\nexport const tick: RrdTick = {t: 1, v: 1};\n',
    });

    const result = compileAngular(dir);

    expect(result.entryPath.endsWith('index.js')).toBe(true);

    result.cleanup();
    rmSync(dir, {recursive: true, force: true});
  });
});
