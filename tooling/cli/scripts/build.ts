import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

import {build} from 'esbuild';

const cliRoot = resolve(import.meta.dirname, '..');
const outDirArgument = process.argv.findIndex((argument) => argument === '--outdir');
const outDir = outDirArgument < 0 ? resolve(cliRoot, 'dist') : resolve(process.argv[outDirArgument + 1] ?? '');
const bundledWorkspacePackages = ['@mndw/sdk-internal', '@mndw/angular-compiler'];

async function main(): Promise<void> {
  mkdirSync(outDir, {recursive: true});

  const result = await build({
    entryPoints: [resolve(cliRoot, 'src/index.ts')],
    outfile: resolve(outDir, 'mndw.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    metafile: true,
    banner: {
      js: [
        '#!/usr/bin/env node',
        'import {createRequire as __mndwCreateRequire} from "node:module";',
        'const require = __mndwCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    plugins: [{
      name: 'externalize-cli-runtime-dependencies',
      setup(pluginBuild) {
        pluginBuild.onLoad({filter: /[/\\]src[/\\]index\.ts$/}, (args) => {
          const contents = readFileSync(args.path, 'utf8').replace(/^#![^\r\n]*(?:\r?\n|$)/, '');

          return {contents, loader: 'ts', resolveDir: dirname(args.path)};
        });

        pluginBuild.onResolve({filter: /.*/}, (args) => {
          const specifier = args.path;
          const workspacePackage = bundledWorkspacePackages.some((name) =>
            specifier === name || specifier.startsWith(`${name}/`)
          );

          if (
            specifier.startsWith('.')
            || specifier.startsWith('/')
            || specifier.startsWith('node:')
            || workspacePackage
          ) {
            return undefined;
          }

          return {path: specifier, external: true};
        });
      },
    }],
  });

  writeFileSync(resolve(outDir, 'meta.json'), `${JSON.stringify(result.metafile, null, 2)}\n`);
  chmodSync(resolve(outDir, 'mndw.js'), 0o755);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
