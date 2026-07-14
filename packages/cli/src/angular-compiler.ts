import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, posix, resolve} from 'node:path';

import {compileString} from 'sass';

import {CliError} from './errors.js';

/** The CLI's own node_modules, where `ngc` and the Angular compiler resolve. */
const CLI_NODE_MODULES = resolve(import.meta.dirname, '..', 'node_modules');

export interface AngularCompileResult {
  readonly entryPath: string;
  readonly cacheDir: string;
  cleanup(): void;
}

/**
 * AOT-compiles an Angular plugin from a staged copy of its standalone tsconfig and src tree. Sass is
 * compiled before ngc and style references are rewritten in the staged TypeScript only; the plugin
 * source is never mutated.
 */
export function compileAngular(pluginDir: string): AngularCompileResult {
  const tsconfigPath = join(pluginDir, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    throw new CliError(`Angular plugin at ${pluginDir} is missing tsconfig.json`);
  }

  let tsconfig: unknown;

  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  } catch {
    throw new CliError(`Invalid tsconfig.json in ${pluginDir}: not valid JSON`);
  }

  if (tsconfig === null || typeof tsconfig !== 'object' || !('angularCompilerOptions' in tsconfig)) {
    throw new CliError(`Angular plugin at ${pluginDir} is missing angularCompilerOptions in tsconfig.json`);
  }

  if ('extends' in tsconfig) {
    throw new CliError(`Angular plugin tsconfig.json must be standalone (no "extends"): ${tsconfigPath}`);
  }

  if (!existsSync(join(pluginDir, 'src'))) {
    throw new CliError(`Angular plugin at ${pluginDir} is missing src/`);
  }

  validateCompileInputs(tsconfig, tsconfigPath);

  const staging = mkdtempSync(join(tmpdir(), 'mndw-ng-stage-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mndw-ng-cache-'));

  try {
    writeStagedTsconfig(tsconfig, staging, pluginDir);
    cpSync(join(pluginDir, 'src'), join(staging, 'src'), {recursive: true});

    const styles = compileScss(join(staging, 'src'));

    const ngc = resolve(CLI_NODE_MODULES, '.bin', 'ngc');

    runNgc(ngc, staging, cacheDir, pluginDir);

    const entryPath = join(cacheDir, 'index.js');

    if (!existsSync(entryPath)) {
      throw new CliError(`Angular compilation produced no index.js in ${cacheDir}`);
    }

    if (styles.length > 0) {
      writeFileSync(join(cacheDir, 'styles.css'), `${styles.join('\n')}\n`);
    }

    return {
      entryPath,
      cacheDir,
      cleanup: () => {
        rmSync(staging, {recursive: true, force: true});
        rmSync(cacheDir, {recursive: true, force: true});
      },
    };
  } catch (error) {
    rmSync(staging, {recursive: true, force: true});
    rmSync(cacheDir, {recursive: true, force: true});

    throw error;
  }
}

function runNgc(ngc: string, staging: string, cacheDir: string, pluginDir: string): void {
  try {
    execFileSync(ngc, ['-p', join(staging, 'tsconfig.json'), '--outDir', cacheDir], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    const details = error as {stdout?: string; stderr?: string; status?: number};
    const output = (details.stderr ?? details.stdout ?? '').slice(-4096);

    throw new CliError(`Angular compilation failed for ${pluginDir} (exit ${details.status})\n${output}`);
  }
}

function writeStagedTsconfig(tsconfig: object, staging: string, pluginDir: string): void {
  const config = tsconfig as Record<string, unknown>;
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
              '@angular/core/testing': [join(CLI_NODE_MODULES, '@angular/core/types/testing.d.ts')],
              '@angular/core/rxjs-interop': [join(CLI_NODE_MODULES, '@angular/core/types/rxjs-interop.d.ts')],
              '@angular/platform-browser/testing': [
                join(CLI_NODE_MODULES, '@angular/platform-browser/types/testing.d.ts'),
              ],
              'd3': [
                join(pluginDir, 'node_modules/@types/d3/index.d.ts'),
                join(pluginDir, 'node_modules/d3'),
                join(CLI_NODE_MODULES, 'd3'),
              ],
              '*': [join(pluginDir, 'node_modules/*'), join(CLI_NODE_MODULES, '*')],
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
      throw new CliError(`Angular plugin tsconfig field "${field}" must be an array of strings: ${tsconfigPath}`);
    }

    for (const rawEntry of value as unknown[]) {
      if (typeof rawEntry !== 'string') {
        throw new CliError(`Angular plugin tsconfig field "${field}" must be an array of strings: ${tsconfigPath}`);
      }

      const entry = rawEntry;
      const normalized = entry.replaceAll('\\', '/');
      const resolved = posix.normalize(`/${normalized}`);

      if (resolved !== '/src' && !resolved.startsWith('/src/')) {
        throw new CliError(`Angular plugin tsconfig ${field} entry must resolve within src: ${entry}`);
      }
    }
  }
}

/** In the staged src tree, compile every `.scss` to a sibling `.css` and rewrite staged references. */
function compileScss(srcDir: string): string[] {
  const styles: string[] = [];

  for (const file of walk(srcDir)) {
    if (file.endsWith('.scss')) {
      const css = compileString(readFileSync(file, 'utf8')).css;

      writeFileSync(file.replace(/\.scss$/, '.css'), css);
      styles.push(css);
    }
  }

  for (const file of walk(srcDir)) {
    if (file.endsWith('.ts')) {
      const source = readFileSync(file, 'utf8');

      if (source.includes('.scss')) {
        writeFileSync(file, source.replaceAll('.scss', '.css'));
      }
    }
  }

  return styles;
}

function walk(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = join(dir, entry.name);

    return entry.isDirectory() ? walk(full) : [full];
  });
}
