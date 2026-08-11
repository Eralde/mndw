import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, posix, relative, resolve} from 'node:path';

import {
  type CompilerOptions,
  EmitFlags,
  type Program,
  createCompilerHost,
  formatDiagnostics,
  performCompilation,
  readConfiguration,
} from '@angular/compiler-cli';
import {compileString} from 'sass';

const COMPILER_NODE_MODULES = resolve(import.meta.dirname, '..', 'node_modules');

export class AngularCompilerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AngularCompilerError';
  }
}

export interface AngularCompileResult {
  readonly entryPath: string;
  readonly cacheDir: string;
  readonly globalStylesPath?: string;
  cleanup(): void;
}

export interface AngularCompilerOutput {
  readonly outputDir: string;
  readonly globalStylesPath?: string;
  sourceToOutput(sourcePath: string): string | undefined;
}

export interface AngularCompiler {
  compileInitial(): AngularCompilerOutput;
  update(changedFiles: readonly string[]): AngularCompilerOutput;
  currentOutput(): AngularCompilerOutput | undefined;
  dispose(): void;
}

export interface AngularCompilerOptions {
  readonly includeComponentStylesInGlobal?: boolean;
}

/**
 * AOT-compiles an Angular plugin from a staged copy of its standalone tsconfig and src tree.
 * Sass is compiled before Angular compilation and the plugin source is never mutated.
 */
export function compileAngular(pluginDir: string, sourceEntry = 'src/index.ts'): AngularCompileResult {
  const compiler = createAngularCompiler(pluginDir, {includeComponentStylesInGlobal: true});

  try {
    const output = compiler.compileInitial();
    const entryPath = output.sourceToOutput(resolve(pluginDir, sourceEntry));

    if (entryPath === undefined || !existsSync(entryPath)) {
      compiler.dispose();
      throw new AngularCompilerError(`Angular compilation produced no ${sourceEntry} output in ${output.outputDir}`);
    }

    return {
      entryPath,
      cacheDir: output.outputDir,
      globalStylesPath: output.globalStylesPath,
      cleanup: () => compiler.dispose(),
    };
  } catch (error) {
    compiler.dispose();
    throw error;
  }
}

export function createAngularCompiler(
  pluginDir: string,
  options: AngularCompilerOptions = {},
): AngularCompiler {
  validatePlugin(pluginDir);

  const staging = mkdtempSync(join(tmpdir(), 'mndw-ng-stage-'));
  let current: AngularCompilerOutput | undefined;
  let program: Program | undefined;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    rmSync(staging, {recursive: true, force: true});

    if (current !== undefined) {
      rmSync(current.outputDir, {recursive: true, force: true});
      current = undefined;
    }
  };

  const compile = (changedFiles: readonly string[], initial: boolean): AngularCompilerOutput => {
    if (disposed) {
      throw new AngularCompilerError('Angular compiler has been disposed');
    }

    const stagedSources = stageSources(
      pluginDir,
      staging,
      changedFiles,
      initial,
      options.includeComponentStylesInGlobal === true,
    );
    const outputDir = mkdtempSync(join(tmpdir(), 'mndw-ng-cache-'));

    try {
      if (current !== undefined) {
        cpSync(current.outputDir, outputDir, {recursive: true});
      }

      const configuration = readConfiguration(join(staging, 'tsconfig.json'));
      const diagnostics = [...configuration.errors];

      if (diagnostics.length > 0) {
        throw compilationError(diagnostics);
      }

      const options: CompilerOptions = {
        ...configuration.options,
        outDir: outputDir,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
      };
      const result = performCompilation({
        rootNames: configuration.rootNames,
        options,
        host: createCompilerHost({options}),
        oldProgram: program,
        emitFlags: EmitFlags.JS,
        forceEmit: true,
        modifiedResourceFiles: initial ? null : stagedSources.modifiedResourceFiles,
      });
      const allDiagnostics = [...result.diagnostics];

      if (allDiagnostics.length > 0) {
        throw compilationError(allDiagnostics);
      }

      if (result.emitResult?.emitSkipped === true || result.program === undefined) {
        throw new AngularCompilerError('Angular compilation emitted no JavaScript output');
      }

      const globalStylesPath = writeGlobalStyles(stagedSources.styles, outputDir);
      const next: AngularCompilerOutput = {
        outputDir,
        globalStylesPath,
        sourceToOutput: (sourcePath: string): string | undefined => sourceToOutput(pluginDir, outputDir, sourcePath),
      };
      const previous = current;
      current = next;
      program = result.program;

      if (previous !== undefined) {
        rmSync(previous.outputDir, {recursive: true, force: true});
      }

      return next;
    } catch (error) {
      rmSync(outputDir, {recursive: true, force: true});
      throw error;
    }
  };

  const compileInitial = (): AngularCompilerOutput => {
    return compile([], true);
  };

  const update = (changedFiles: readonly string[]): AngularCompilerOutput => {
    if (current === undefined) {
      return compileInitial();
    }

    return compile(changedFiles, false);
  };

  return {
    compileInitial,
    update,
    currentOutput: (): AngularCompilerOutput | undefined => current,
    dispose,
  };
}

function validatePlugin(pluginDir: string): void {
  const tsconfigPath = join(pluginDir, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    throw new AngularCompilerError(`Angular plugin at ${pluginDir} is missing tsconfig.json`);
  }

  let tsconfig: unknown;

  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  } catch {
    throw new AngularCompilerError(`Invalid tsconfig.json in ${pluginDir}: not valid JSON`);
  }

  if (tsconfig === null || typeof tsconfig !== 'object' || !('angularCompilerOptions' in tsconfig)) {
    throw new AngularCompilerError(`Angular plugin at ${pluginDir} is missing angularCompilerOptions in tsconfig.json`);
  }

  if ('extends' in tsconfig) {
    throw new AngularCompilerError(`Angular plugin tsconfig.json must be standalone (no "extends"): ${tsconfigPath}`);
  }

  if (!existsSync(join(pluginDir, 'src'))) {
    throw new AngularCompilerError(`Angular plugin at ${pluginDir} is missing src/`);
  }

  validateCompileInputs(tsconfig, tsconfigPath);
}

function stageSources(
  pluginDir: string,
  staging: string,
  changedFiles: readonly string[],
  initial: boolean,
  includeComponentStylesInGlobal: boolean,
): {modifiedResourceFiles: Set<string>; styles: string[]} {
  if (initial) {
    writeStagedTsconfig(readFileSync(join(pluginDir, 'tsconfig.json'), 'utf8'), staging, pluginDir);
    cpSync(join(pluginDir, 'src'), join(staging, 'src'), {recursive: true});
  } else {
    for (const changedFile of changedFiles) {
      const sourceFile = resolve(changedFile);
      const sourceRoot = resolve(pluginDir, 'src');
      const sourceRelative = relative(sourceRoot, sourceFile);

      if (sourceRelative.startsWith('..')) {
        continue;
      }

      const stagedFile = join(staging, 'src', sourceRelative);

      if (existsSync(sourceFile)) {
        mkdirSync(resolve(stagedFile, '..'), {recursive: true});
        cpSync(sourceFile, stagedFile);
      } else {
        rmSync(stagedFile, {force: true});

        if (sourceRelative.endsWith('.scss')) {
          rmSync(stagedFile.replace(/\.scss$/, '.css'), {force: true});
        }
      }
    }
  }

  const compiledStyles = compileScss(join(staging, 'src'), includeComponentStylesInGlobal);

  if (initial) {
    return {modifiedResourceFiles: new Set(), styles: compiledStyles.styles};
  }

  for (const changedFile of changedFiles) {
    const sourceFile = resolve(changedFile);
    const sourceRelative = relative(resolve(pluginDir, 'src'), sourceFile);

    if (!sourceRelative.startsWith('..')) {
      compiledStyles.modifiedResourceFiles.add(join(staging, 'src', sourceRelative));
    }
  }

  return compiledStyles;
}

function writeStagedTsconfig(tsconfigJson: string, staging: string, pluginDir: string): void {
  const config = JSON.parse(tsconfigJson) as Record<string, unknown>;
  const sourceCompilerOptions = config.compilerOptions;
  const compilerOptions = sourceCompilerOptions !== null && typeof sourceCompilerOptions === 'object'
    ? sourceCompilerOptions as Record<string, unknown>
    : {};
  const sourcePaths = compilerOptions.paths;
  const paths = sourcePaths !== null && typeof sourcePaths === 'object'
    ? sourcePaths as Record<string, unknown>
    : {};

  writeFileSync(
    join(staging, 'tsconfig.json'),
    `${
      JSON.stringify(
        {
          ...config,
          compilerOptions: {
            ...compilerOptions,
            baseUrl: compilerOptions.baseUrl ?? staging,
            paths: {
              '@angular/core/testing': [join(COMPILER_NODE_MODULES, '@angular/core/types/testing.d.ts')],
              '@angular/core/rxjs-interop': [join(COMPILER_NODE_MODULES, '@angular/core/types/rxjs-interop.d.ts')],
              '@angular/platform-browser/testing': [
                join(COMPILER_NODE_MODULES, '@angular/platform-browser/types/testing.d.ts'),
              ],
              d3: [
                join(pluginDir, 'node_modules/@types/d3/index.d.ts'),
                join(pluginDir, 'node_modules/d3'),
                join(COMPILER_NODE_MODULES, 'd3'),
              ],
              '@mndw/sdk/*': [
                join(pluginDir, 'node_modules/@mndw/sdk/src/*'),
                join(COMPILER_NODE_MODULES, '@mndw/sdk/src/*'),
              ],
              '*': [join(pluginDir, 'node_modules/*'), join(COMPILER_NODE_MODULES, '*')],
              ...paths,
            },
          },
        },
        null,
        2,
      )
    }\n`,
  );
}

function validateCompileInputs(tsconfig: object, tsconfigPath: string): void {
  const config = tsconfig as Record<string, unknown>;

  for (const field of ['include', 'files']) {
    if (!(field in config)) {
      continue;
    }

    const value = config[field];

    if (!Array.isArray(value)) {
      throw new AngularCompilerError(
        `Angular plugin tsconfig field "${field}" must be an array of strings: ${tsconfigPath}`,
      );
    }

    for (const rawEntry of value as unknown[]) {
      if (typeof rawEntry !== 'string') {
        throw new AngularCompilerError(
          `Angular plugin tsconfig field "${field}" must be an array of strings: ${tsconfigPath}`,
        );
      }

      const normalized = rawEntry.replaceAll('\\', '/');
      const resolved = posix.normalize(`/${normalized}`);

      if (resolved !== '/src' && !resolved.startsWith('/src/')) {
        throw new AngularCompilerError(`Angular plugin tsconfig ${field} entry must resolve within src: ${rawEntry}`);
      }
    }
  }
}

function compileScss(
  srcDir: string,
  includeComponentStylesInGlobal: boolean,
): {modifiedResourceFiles: Set<string>; styles: string[]} {
  const modified = new Set<string>();
  const styles: string[] = [];
  const componentStyles = new Set<string>();

  for (const file of walk(srcDir)) {
    if (!file.endsWith('.ts')) {
      continue;
    }

    const source = readFileSync(file, 'utf8');
    const references = source.matchAll(/['"]([^'"]+\.scss)['"]/g);

    for (const [, reference] of references) {
      if (reference !== undefined) {
        componentStyles.add(resolve(file, '..', reference));
      }
    }
  }

  for (const file of walk(srcDir)) {
    if (file.endsWith('.scss')) {
      const cssFile = file.replace(/\.scss$/, '.css');
      const css = compileString(readFileSync(file, 'utf8'), {loadPaths: [srcDir]}).css;

      writeFileSync(cssFile, css);
      modified.add(cssFile);

      if (includeComponentStylesInGlobal || !componentStyles.has(file)) {
        styles.push(css);
      }
    }
  }

  for (const file of walk(srcDir)) {
    if (file.endsWith('.ts')) {
      const source = readFileSync(file, 'utf8');

      if (source.includes('.scss')) {
        writeFileSync(file, source.replaceAll('.scss', '.css'));
        modified.add(file);
      }
    }
  }

  return {modifiedResourceFiles: modified, styles};
}

function writeGlobalStyles(styles: readonly string[], outputDir: string): string | undefined {
  const nonEmptyStyles = styles.filter((css) => css.length > 0);
  const globalStylesPath = join(outputDir, 'styles.css');

  if (nonEmptyStyles.length === 0) {
    rmSync(globalStylesPath, {force: true});
    return undefined;
  }

  writeFileSync(globalStylesPath, `${nonEmptyStyles.join('\n')}\n`);
  return globalStylesPath;
}

function sourceToOutput(pluginDir: string, outputDir: string, sourcePath: string): string | undefined {
  const sourceRoot = resolve(pluginDir, 'src');
  const absoluteSourcePath = resolve(sourcePath);
  const sourceRelative = relative(sourceRoot, absoluteSourcePath);

  if (sourceRelative.startsWith('..') || !sourceRelative.endsWith('.ts')) {
    return undefined;
  }

  return join(outputDir, sourceRelative.replace(/\.ts$/, '.js'));
}

function compilationError(diagnostics: readonly import('typescript').Diagnostic[]): AngularCompilerError {
  return new AngularCompilerError(`Angular compilation failed\n${formatDiagnostics(diagnostics)}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = join(dir, entry.name);

    return entry.isDirectory() ? walk(full) : [full];
  });
}
