import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {type AngularCompiler, createAngularCompiler} from '../../../frontend/angular-compiler/src/index.ts';
import {defineConfig} from 'vitest/config';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = resolve(pluginDir, 'src');
const require = createRequire(import.meta.url);
const tempDirectory = tmpdir();
const realTempDirectory = realpathSync.native(tempDirectory);
let angularCompiler: AngularCompiler | undefined;

function sourceModulePath(importer: string, source: string): string | undefined {
  if (!source.startsWith('.')) {
    return undefined;
  }

  const sourceImporter = isCompilerOutputPath(importer)
    ? compilerOutputSourcePath(importer)
    : importer;

  if (!sourceImporter?.startsWith(sourceRoot)) {
    return undefined;
  }

  const candidate = resolve(dirname(sourceImporter), source);
  const sourcePath = candidate.endsWith('.ts') ? candidate : `${candidate}.ts`;

  if (!sourcePath.startsWith(`${sourceRoot}/`) || !existsSync(sourcePath)) {
    return undefined;
  }

  const output = sourcePath.endsWith('.component.ts')
    ? angularCompiler?.currentOutput()?.sourceToOutput(sourcePath)
    : undefined;

  return output !== undefined && existsSync(output) ? output : sourcePath;
}

function compilerOutputSourcePath(importer: string): string | undefined {
  const output = angularCompiler?.currentOutput();

  if (output === undefined || !isCompilerOutputPath(importer)) {
    return undefined;
  }

  const sourceRelative = relative(output.outputDir, canonicalPath(importer)).replace(/\.js$/, '.ts');

  return resolve(sourceRoot, sourceRelative);
}

function canonicalPath(path: string): string {
  return path.startsWith(`${realTempDirectory}/`)
    ? `${tempDirectory}${path.slice(realTempDirectory.length)}`
    : path;
}

function isCompilerOutputPath(path: string): boolean {
  return canonicalPath(path).startsWith(`${tempDirectory}/`) && path.endsWith('.js');
}

export default defineConfig({
  test: {environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']},
  plugins: [{
    name: 'mndw-angular-aot-test-compiler',
    enforce: 'pre',
    configResolved: () => {
      angularCompiler = createAngularCompiler(pluginDir);
      angularCompiler.compileInitial();
      process.once('exit', () => angularCompiler?.dispose());
    },
    resolveId: (source: string, importer: string | undefined) => {
      if (importer === undefined) {
        return null;
      }

      const compiledSource = sourceModulePath(importer, source);

      if (compiledSource !== undefined) {
        return compiledSource;
      }

      if (isCompilerOutputPath(importer) && !source.startsWith('.')) {
        try {
          return require.resolve(source, {paths: [pluginDir]});
        } catch {
          return null;
        }
      }

      return null;
    },
    load: (id: string) => {
      const filePath = canonicalPath(id);

      return isCompilerOutputPath(id) && existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    },
  }],
});
