import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import type {AngularCompiler, AngularCompilerOutput} from '@mndw/angular-compiler';

import {type AngularSandboxPluginDeps, angularSandboxPlugin} from './angular-sandbox-plugin.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function makeCompiler(pluginDir: string, failUpdates = false): AngularCompiler {
  const sourceFile = resolve(pluginDir, 'src', 'index.ts');
  const firstOutput = mkdtempSync(join(tmpdir(), 'mndw-angular-output-'));
  const secondOutput = mkdtempSync(join(tmpdir(), 'mndw-angular-output-'));
  temporaryDirectories.push(firstOutput, secondOutput);
  writeFileSync(join(firstOutput, 'index.js'), 'export const version = 1;');
  writeFileSync(join(secondOutput, 'index.js'), 'export const version = 2;');
  writeFileSync(join(firstOutput, 'styles.css'), '.global{color:red}');
  writeFileSync(join(secondOutput, 'styles.css'), '.global{color:blue}');

  const first: AngularCompilerOutput = {
    outputDir: firstOutput,
    globalStylesPath: join(firstOutput, 'styles.css'),
    sourceToOutput: (sourcePath) => sourcePath === sourceFile ? join(firstOutput, 'index.js') : undefined,
  };
  const second: AngularCompilerOutput = {
    outputDir: secondOutput,
    globalStylesPath: join(secondOutput, 'styles.css'),
    sourceToOutput: (sourcePath) => sourcePath === sourceFile ? join(secondOutput, 'index.js') : undefined,
  };
  let current = first;

  return {
    compileInitial: () => first,
    update: () => {
      if (failUpdates) {
        throw new Error('Angular compilation failed');
      }

      current = second;

      return second;
    },
    currentOutput: () => current,
    dispose: vi.fn(),
  };
}

function pluginDeps(compiler: AngularCompiler): AngularSandboxPluginDeps {
  return {createCompiler: () => compiler};
}

function makePlugin(): {pluginDir: string; sourceFile: string} {
  const pluginDir = mkdtempSync(join(tmpdir(), 'mndw-angular-sandbox-plugin-'));
  temporaryDirectories.push(pluginDir);
  const sourceDir = join(pluginDir, 'src');
  mkdirSync(sourceDir);
  const sourceFile = join(sourceDir, 'index.ts');
  writeFileSync(sourceFile, 'export const version = 1;');

  return {pluginDir, sourceFile};
}

describe('angularSandboxPlugin', () => {
  it('serves compiled JavaScript for source module ids and virtual global styles', () => {
    const {pluginDir, sourceFile} = makePlugin();
    const plugin = angularSandboxPlugin(pluginDir, pluginDeps(makeCompiler(pluginDir)));
    const transform = plugin.transform as (code: string, id: string) => {code: string} | null;
    const load = plugin.load as (id: string) => string | undefined;
    const transformed = transform('raw source', sourceFile);

    expect(transformed?.code).toContain('version = 1');
    expect(transformed?.code).toContain('mndw-angular-global-styles');

    const resolvedStyles = `\0virtual:mndw-angular-global-styles:${encodeURIComponent(pluginDir)}.js`;
    const styles = load(resolvedStyles);

    expect(styles).toContain('.global{color:red}');
  });

  it('updates affected modules and keeps current output after failed HMR compilation', () => {
    const {pluginDir, sourceFile} = makePlugin();
    const compiler = makeCompiler(pluginDir, true);
    const plugin = angularSandboxPlugin(pluginDir, pluginDeps(compiler));
    const module = {id: sourceFile};
    const logger = {error: vi.fn()};
    const server = {
      moduleGraph: {
        idToModuleMap: new Map([[sourceFile, module]]),
        getModuleById: vi.fn(),
        invalidateModule: vi.fn(),
      },
      config: {logger},
    };
    const handleHotUpdate = plugin.handleHotUpdate as unknown as (
      context: {file: string; server: typeof server},
    ) => unknown;

    expect(handleHotUpdate({file: sourceFile, server})).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Angular compilation failed'));
    expect(server.moduleGraph.invalidateModule).not.toHaveBeenCalled();
  });

  it('publishes successful HMR output and disposes compiler with Vite', () => {
    const {pluginDir, sourceFile} = makePlugin();
    const compiler = makeCompiler(pluginDir);
    const plugin = angularSandboxPlugin(pluginDir, pluginDeps(compiler));
    const sourceModule = {id: sourceFile};
    const styleModule = {id: `\0virtual:mndw-angular-global-styles:${encodeURIComponent(pluginDir)}.js`};
    const server = {
      moduleGraph: {
        idToModuleMap: new Map([[sourceFile, sourceModule]]),
        getModuleById: vi.fn((id: string) => id === styleModule.id ? styleModule : undefined),
        invalidateModule: vi.fn(),
      },
      config: {logger: {error: vi.fn()}},
    };
    const handleHotUpdate = plugin.handleHotUpdate as unknown as (
      context: {file: string; server: typeof server},
    ) => unknown;
    const affected = handleHotUpdate({file: sourceFile, server});
    const transform = plugin.transform as (code: string, id: string) => {code: string} | null;

    expect(affected).toHaveLength(2);
    expect(server.moduleGraph.invalidateModule).toHaveBeenCalledTimes(2);
    expect(transform('raw source', sourceFile)?.code).toContain('version = 2');

    const dispose = vi.spyOn(compiler, 'dispose');
    const closeBundle = plugin.closeBundle as unknown as () => void;
    closeBundle();

    expect(dispose).toHaveBeenCalledOnce();
  });
});
