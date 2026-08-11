import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import * as compilerCli from '@angular/compiler-cli';
import {afterEach, describe, expect, it} from 'vitest';

import {compileAngular, createAngularCompiler} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function makePlugin(includeGlobalStyles = false): string {
  const pluginDir = mkdtempSync(join(tmpdir(), 'mndw-angular-compiler-test-'));
  temporaryDirectories.push(pluginDir);

  writeFileSync(
    join(pluginDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        experimentalDecorators: true,
        useDefineForClassFields: false,
        rootDir: 'src',
      },
      angularCompilerOptions: {strictInjectionParameters: true},
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    }),
  );
  writeFileSync(join(pluginDir, 'manifest.json'), '{}');

  const sourceDir = join(pluginDir, 'src');
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, 'index.ts'), 'export {AppComponent} from \'./app.component\';\n');
  writeFileSync(
    join(sourceDir, 'app.component.ts'),
    `import {Component, input} from '@angular/core';

@Component({
  selector: 'x-root',
  standalone: true,
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent {
  public readonly label = input<string>('initial');
}
`,
  );
  writeFileSync(join(sourceDir, 'app.component.html'), '<p>{{ label() }}</p>\n');
  writeFileSync(join(sourceDir, 'app.component.scss'), '.component { color: red; }\n');
  mkdirSync(join(sourceDir, 'nested'));
  writeFileSync(join(sourceDir, 'nested', 'child.ts'), 'export const child = true;\n');

  if (includeGlobalStyles) {
    writeFileSync(join(sourceDir, 'global.scss'), '.global { color: blue; }\n');
  }

  return pluginDir;
}

describe('Angular compiler public API', () => {
  it('uses compiler APIs exported from the package root', () => {
    expect(typeof compilerCli.NgtscProgram).toBe('function');
    expect(typeof compilerCli.performCompilation).toBe('function');
    expect(typeof compilerCli.readConfiguration).toBe('function');
  });
});

describe('compileAngular', () => {
  it('AOT-compiles a plugin without mutating source files', () => {
    const pluginDir = makePlugin();
    const source = readFileSync(join(pluginDir, 'src', 'app.component.ts'), 'utf8');
    const result = compileAngular(pluginDir);

    expect(existsSync(result.entryPath)).toBe(true);
    expect(readFileSync(join(result.cacheDir, 'app.component.js'), 'utf8')).toContain('ɵɵdefineComponent');
    expect(readFileSync(join(pluginDir, 'src', 'app.component.ts'), 'utf8')).toBe(source);

    result.cleanup();
  });
});

describe('createAngularCompiler', () => {
  it('maps source modules, recompiles incrementally, and exposes global styles', () => {
    const pluginDir = makePlugin(true);
    const compiler = createAngularCompiler(pluginDir);
    const first = compiler.compileInitial();
    const componentSource = join(pluginDir, 'src', 'app.component.ts');

    expect(first.sourceToOutput(componentSource)).toBe(join(first.outputDir, 'app.component.js'));
    expect(first.globalStylesPath).toBeDefined();
    const firstGlobalStylesPath = first.globalStylesPath;

    expect(firstGlobalStylesPath).toBeDefined();
    expect(firstGlobalStylesPath === undefined ? '' : readFileSync(firstGlobalStylesPath, 'utf8')).toContain('.global');
    expect(firstGlobalStylesPath === undefined ? '' : readFileSync(firstGlobalStylesPath, 'utf8'))
      .not.toContain('.component');
    expect(first.sourceToOutput(join(pluginDir, 'src', 'nested', 'child.ts')))
      .toBe(join(first.outputDir, 'nested', 'child.js'));

    writeFileSync(componentSource, readFileSync(componentSource, 'utf8').replace('initial', 'updated'));
    const second = compiler.update([componentSource]);

    expect(second.outputDir).not.toBe(first.outputDir);
    const secondComponentOutput = second.sourceToOutput(componentSource);

    expect(secondComponentOutput).toBeDefined();
    expect(secondComponentOutput === undefined ? '' : readFileSync(secondComponentOutput, 'utf8')).toContain('updated');

    const templatePath = join(pluginDir, 'src', 'app.component.html');
    writeFileSync(templatePath, '<h1>{{ label() }}</h1>\n');
    const third = compiler.update([templatePath]);

    const thirdComponentOutput = third.sourceToOutput(componentSource);

    expect(thirdComponentOutput).toBeDefined();
    expect(thirdComponentOutput === undefined ? '' : readFileSync(thirdComponentOutput, 'utf8')).toContain('<h1>');

    const stylePath = join(pluginDir, 'src', 'app.component.scss');
    writeFileSync(stylePath, '.component { color: green; }\n');
    const fourth = compiler.update([stylePath]);

    const fourthComponentOutput = fourth.sourceToOutput(componentSource);

    expect(fourthComponentOutput).toBeDefined();
    expect(fourthComponentOutput === undefined ? '' : readFileSync(fourthComponentOutput, 'utf8')).toContain('green');
    compiler.dispose();
  });

  it('keeps last successful output when an update has diagnostics', () => {
    const pluginDir = makePlugin();
    const compiler = createAngularCompiler(pluginDir);
    const first = compiler.compileInitial();
    const componentSource = join(pluginDir, 'src', 'app.component.ts');

    writeFileSync(componentSource, 'export class Broken {');

    expect(() => compiler.update([componentSource])).toThrow();
    expect(compiler.currentOutput()?.outputDir).toBe(first.outputDir);
    compiler.dispose();
  });
});
